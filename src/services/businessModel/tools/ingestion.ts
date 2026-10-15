import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import pdfParse from 'pdf-parse-fork';
import { getGeminiClient, GeminiClient } from './geminiClient';
import { NormalizedDoc, ReadFrom, SourcedMetric, SourcedTable, SourcedText, TraceLogger } from './types';

const CACHE_VERSION = 'v2';
const MAX_INLINE_PDF_BYTES = 18 * 1024 * 1024;

const slideLabel = (n: any): string | null => {
  const num = Number(n);
  return Number.isFinite(num) && num > 0 ? `Slide ${num}` : null;
};
const numOrNull = (v: any): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(/,/g, '')))) {
    return Number(v.replace(/,/g, ''));
  }
  return null;
};

export class IngestionService {
  private gemini: GeminiClient;
  // INGESTION_STRICT=true makes vision-pass failures throw instead of degrading to text only.
  private strict = process.env.INGESTION_STRICT === 'true';
  private cacheEnabled = process.env.INGESTION_CACHE !== 'false';

  constructor() {
    this.gemini = getGeminiClient();
  }

  private async isFile(p: string): Promise<boolean> {
    return fs.stat(p).then((s) => s.isFile()).catch(() => false);
  }

  /** 1. Embedded text, one block per page, tagged with page number. */
  private async extractPdfText(buffer: Buffer, trace?: TraceLogger): Promise<SourcedText[]> {
    const pages: string[] = [];
    try {
      await pdfParse(buffer, {
        pagerender: async (pageData: any) => {
          const content = await pageData.getTextContent({ normalizeWhitespace: true });
          const text = content.items
            .map((item: any) => item.str)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          pages.push(text);
          return text;
        },
      });
    } catch (e: any) {
      trace?.log('ingestion', 'Native text parsing failed', { error: e?.message || String(e) });
    }

    const texts: SourcedText[] = pages
      .map((text, i) => ({ id: `pt${i + 1}`, page: i + 1, text, source: 'pdf-text' as const }))
      .filter((t) => t.text.length > 0);

    const totalChars = texts.reduce((n, t) => n + t.text.length, 0);
    trace?.log('ingestion', `Embedded text: ${texts.length} pages, ${totalChars} chars`);
    return totalChars > 50 ? texts : [];
  }

  /** 2. Vision pass: slide transcription, structured tables, and metrics tagged by where they were read from. */
  private async visionPass(
    buffer: Buffer,
    trace?: TraceLogger
  ): Promise<{ texts: SourcedText[]; tables: SourcedTable[]; metrics: SourcedMetric[] }> {
    if (buffer.length > MAX_INLINE_PDF_BYTES) {
      throw new Error(
        `PDF is ${(buffer.length / 1024 / 1024).toFixed(1)}MB; use the Gemini Files API for large PDFs.`
      );
    }

    const prompt = `
      You are analyzing a startup pitch deck PDF. Slide numbers are the PDF page numbers (1-based).
      Do three things:
      1. "slides": for every slide, transcribe key text and numbers into plain prose.
      2. "tables": reproduce every literal table as structured data (headers + rows of strings), noting its slide.
      3. "metrics": list every financial or unit-economics figure visible (e.g. CAC, LTV, payback period, price per unit,
         gross margin, COGS, revenue, opex, EBITDA, growth rate, churn, ARPU, marketing spend, new customers, cash, burn).
         For each, set "readFrom" to where the number appears: "text" (written in prose/bullets), "table" (inside a table),
         or "chart" (read off a graph or infographic). For chart reads, give your best "low" and "high" estimate around "value".
         For text/table reads, set "low" and "high" to null. Keep the deck's own currency and units; do not convert.

      Return ONLY JSON in this exact shape:
      {
        "slides": [{ "slide": 1, "text": "string" }],
        "tables": [{ "slide": 5, "title": "string", "headers": ["string"], "rows": [["string"]] }],
        "metrics": [{ "label": "string", "value": 5000, "low": null, "high": null, "unit": "INR or % or months or count",
                      "slide": 4, "readFrom": "text|table|chart", "context": "string" }]
      }
    `;

    const { data, model } = await this.gemini.generateJson<any>(
      'Ingestion',
      [{ inlineData: { mimeType: 'application/pdf', data: buffer.toString('base64') } }, { text: prompt }],
      { temperature: 0.1 }
    );

    const texts: SourcedText[] = (Array.isArray(data.slides) ? data.slides : [])
      .filter((s: any) => s && typeof s.text === 'string' && s.text.trim())
      .map((s: any, i: number) => ({
        id: `vt${i + 1}`,
        page: numOrNull(s.slide),
        text: s.text.trim(),
        source: 'vision' as const,
      }));

    const tables: SourcedTable[] = (Array.isArray(data.tables) ? data.tables : []).map((t: any, i: number) => ({
      id: `tb${i + 1}`,
      slide: slideLabel(t?.slide),
      title: String(t?.title || ''),
      headers: Array.isArray(t?.headers) ? t.headers.map(String) : [],
      rows: Array.isArray(t?.rows) ? t.rows.map((r: any) => (Array.isArray(r) ? r.map(String) : [String(r)])) : [],
      source: 'vision' as const,
    }));

    const readFroms: ReadFrom[] = ['text', 'table', 'chart'];
    const metrics: SourcedMetric[] = (Array.isArray(data.metrics) ? data.metrics : [])
      .filter((m: any) => m && m.label)
      .map((m: any, i: number) => ({
        id: `m${i + 1}`,
        label: String(m.label),
        value: numOrNull(m.value),
        low: numOrNull(m.low),
        high: numOrNull(m.high),
        unit: m.unit ? String(m.unit) : null,
        slide: slideLabel(m.slide),
        readFrom: readFroms.includes(m.readFrom) ? m.readFrom : 'text',
        context: String(m.context || ''),
        source: 'vision' as const,
      }));

    trace?.log('ingestion', `Vision pass (${model}): ${texts.length} slides, ${tables.length} tables, ${metrics.length} metrics`, {
      chartReads: metrics.filter((m) => m.readFrom === 'chart').length,
    });
    return { texts, tables, metrics };
  }

  /** 3. Normalization: merge all sources into one provenance-tagged document. */
  public async extractAndNormalize(documentInput: string, trace?: TraceLogger): Promise<NormalizedDoc> {
    // Raw text blob instead of a file path.
    if (!(await this.isFile(documentInput))) {
      if (documentInput.toLowerCase().endsWith('.pdf')) {
        throw new Error(`PDF file not found: ${documentInput}`);
      }
      trace?.log('ingestion', 'Input treated as a raw text blob; vision pass skipped');
      return {
        texts: [{ id: 'tb0', page: null, text: documentInput, source: 'text-blob' }],
        tables: [],
        metrics: [],
        sourcesUsed: ['text-blob'],
        visionSucceeded: false,
      };
    }

    const buffer = await fs.readFile(documentInput);

    // Cache by content hash so repeat runs skip the paid vision call.
    let cacheFile: string | null = null;
    if (this.cacheEnabled) {
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      const dir = path.join(process.cwd(), '.cache', 'ingestion');
      await fs.mkdir(dir, { recursive: true });
      cacheFile = path.join(dir, `${hash}.${CACHE_VERSION}.json`);
      try {
        const cached = JSON.parse(await fs.readFile(cacheFile, 'utf-8')) as NormalizedDoc;
        trace?.log('ingestion', 'Using cached ingestion result');
        return cached;
      } catch {
        // cache miss
      }
    }

    const pdfTexts = await this.extractPdfText(buffer, trace);

    let vision: { texts: SourcedText[]; tables: SourcedTable[]; metrics: SourcedMetric[] } = {
      texts: [],
      tables: [],
      metrics: [],
    };
    let visionSucceeded = false;
    try {
      vision = await this.visionPass(buffer, trace);
      visionSucceeded = true;
    } catch (err: any) {
      console.error('[IngestionService] Vision pass failed:', err);
      trace?.log('ingestion', 'Vision pass failed', { error: err?.message || String(err) });
      if (this.strict) throw err;
    }

    const texts = [...pdfTexts, ...vision.texts];
    if (texts.length === 0 && vision.tables.length === 0 && vision.metrics.length === 0) {
      throw new Error('No content could be extracted from the document (no text layer and the vision pass returned nothing).');
    }

    const sourcesUsed = [
      ...(pdfTexts.length ? ['pdf-parse-fork'] : []),
      ...(visionSucceeded ? ['gemini-vision-extraction'] : []),
    ];

    const doc: NormalizedDoc = { texts, tables: vision.tables, metrics: vision.metrics, sourcesUsed, visionSucceeded };

    // Only cache complete results, never degraded ones.
    if (cacheFile && visionSucceeded) {
      await fs.writeFile(cacheFile, JSON.stringify(doc), 'utf-8');
    }
    return doc;
  }
}

/** Renders the normalized doc as labelled text for downstream LLM steps. */
export function renderNormalizedDoc(doc: NormalizedDoc, maxChars = 120000): string {
  const parts: string[] = [];

  parts.push('=== TEXT (labelled by source and page/slide) ===');
  for (const t of doc.texts) {
    const loc = t.page !== null ? ` p${t.page}` : '';
    parts.push(`[${t.source}${loc}] ${t.text}`);
  }

  if (doc.tables.length) {
    parts.push('\n=== TABLES ===');
    for (const tb of doc.tables) {
      parts.push(`[table ${tb.slide ?? 'slide ?'}] ${tb.title}`);
      parts.push(tb.headers.join(' | '));
      for (const r of tb.rows) parts.push(r.join(' | '));
    }
  }

  if (doc.metrics.length) {
    parts.push('\n=== EXTRACTED METRICS (read-from tagged) ===');
    for (const m of doc.metrics) {
      const range = m.low !== null && m.high !== null ? ` (est. range ${m.low} to ${m.high})` : '';
      parts.push(
        `[metric ${m.slide ?? 'slide ?'}, read from ${m.readFrom}] ${m.label} = ${m.value ?? 'n/a'} ${m.unit ?? ''}${range}. ${m.context}`
      );
    }
  }

  const out = parts.join('\n');
  return out.length > maxChars ? out.slice(0, maxChars) + '\n[truncated]' : out;
}