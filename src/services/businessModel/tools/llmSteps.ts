import { getGeminiClient, GeminiClient } from './geminiClient';
import { renderNormalizedDoc } from './ingestion';
import {
  AgentFlag,
  AgentInput,
  FIELD_NAMES,
  FieldCandidate,
  FieldName,
  MapperOutput,
  MOAT_TAXONOMY,
  MoatType,
  NormalizedDoc,
  Provenance,
  ReadFrom,
  ResolvedMetrics,
  scoreConfidence,
  Severity,
  TraceLogger,
} from './types';

// ==================== Field mapper (locates explicitly stated values) ====================

const FIELD_HELP: Record<FieldName, string> = {
  cac: 'Customer acquisition cost PER customer/unit, as stated',
  ltv: 'Customer lifetime value, as stated',
  paybackPeriodMonths: 'CAC payback period in months, exactly as stated in the deck',
  grossMarginPct: 'Stated gross margin, 0-100 scale (80 means 80%)',
  pricePerUnit: 'Price per unit / evaluation / seat',
  arpuMonthly: 'Average revenue per customer per MONTH',
  monthlyChurnPct: 'Monthly customer churn, 0-100 scale',
  customerLifetimeMonths: 'Average customer lifetime in months',
  marketingSpend: 'Total sales & marketing spend for a stated period (the number only)',
  newCustomers: 'New customers acquired in that SAME period',
  cogsPerUnit: 'Cost of goods sold per unit',
  year1Revenue: 'Total Year 1 revenue',
  year1Cogs: 'Total Year 1 COGS',
  year1GrossProfit: 'Total Year 1 gross profit',
  year1Opex: 'Total Year 1 operating expenses, EXCLUDING COGS',
  year1OperatingProfit: 'Year 1 operating profit / EBITDA',
  monthlyGrowthPct: 'Assumed month-over-month growth, 0-100 scale',
  cashBalance: 'Current cash on hand',
  monthlyBurn: 'Current or projected monthly burn',
};

const emptyCandidate = (): FieldCandidate => ({
  value: null,
  unit: null,
  slide: null,
  readFrom: null,
  evidence: null,
  low: null,
  high: null,
});

const toNum = (v: any): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, '').trim());
    if (v.trim() !== '' && Number.isFinite(n)) return n;
  }
  return null;
};
const toStr = (v: any): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
};

/**
 * Locates candidate values with semantic matching over the normalized doc.
 * It only reports what the deck STATES explicitly. Derivation and benchmarks happen later,
 * in code, so provenance stays honest.
 */
export class FieldMapperService {
  private gemini: GeminiClient;

  constructor() {
    this.gemini = getGeminiClient();
  }

  public async mapFields(doc: NormalizedDoc, input: AgentInput, trace?: TraceLogger): Promise<MapperOutput> {
    const schemaFields = FIELD_NAMES.map(
      (n) =>
        `    "${n}": { "value": number|null, "unit": string|null, "slide": "Slide N"|null, "readFrom": "text"|"table"|"chart"|null, "evidence": string|null, "low": number|null, "high": number|null }`
    ).join(',\n');

    const prompt = `
      You are an expert VC associate locating unit-economics figures in a startup pitch deck.
      Company: ${input.startup_name} | category: ${input.category} | stage: ${input.stage} | sector: ${input.sector}

      Strict rules:
      - Report ONLY values the deck states explicitly. If a value is not written in the deck, set value to null. NEVER derive, estimate or guess here; derivation is done separately.
      - Decks use inconsistent terminology ("cost to acquire", "acquisition spend per user", "fee per evaluation"): match by meaning, not keywords.
      - All monetary values are plain numbers in full units in the deck's own currency (e.g. 1700000, not "17 Lakh"). Do not convert currencies.
      - Percentages are on a 0-100 scale.
      - "slide" is where the value appears (e.g. "Slide 34"). "readFrom" is "text", "table" or "chart". For chart reads, give your best low/high estimate; otherwise set low/high to null.
      - "evidence" is a short paraphrase (max 25 words) of what the deck says about it.
      - Use the EXTRACTED METRICS section as hints, but re-check against the text and tables.

      Field meanings:
${FIELD_NAMES.map((n) => `      - ${n}: ${FIELD_HELP[n]}`).join('\n')}

      Also return:
      - "currency": currency code used for monetary values (e.g. "INR"), or "Unknown".
      - "pricingStrategy": { "value": short description of how the product is priced (model + price points) or null, "slide": string|null, "evidence": string|null }
      - "moatEvidence": 1-3 sentences on what the deck ITSELF claims about defensibility (data, IP, integrations, partnerships, switching costs), or null if it says nothing.

      Return ONLY JSON in this shape:
      {
        "currency": "string",
        "pricingStrategy": { "value": string|null, "slide": string|null, "evidence": string|null },
        "moatEvidence": string|null,
        "fields": {
${schemaFields}
        }
      }

      DOCUMENT:
      ${renderNormalizedDoc(doc)}
    `;

    const { data, model } = await this.gemini.generateJson<any>('FieldMapper', [{ text: prompt }], {
      temperature: 0.1,
    });

    const readFroms: ReadFrom[] = ['text', 'table', 'chart'];
    const fields = {} as Record<FieldName, FieldCandidate>;
    for (const name of FIELD_NAMES) {
      const raw = data?.fields?.[name];
      if (!raw || typeof raw !== 'object') {
        fields[name] = emptyCandidate();
        continue;
      }
      let value = toNum(raw.value);
      // Guard: a gross margin written as a fraction (0.8) is almost certainly 80%.
      if (name === 'grossMarginPct' && value !== null && value > 0 && value <= 1) value = value * 100;

      fields[name] = {
        value,
        unit: toStr(raw.unit),
        slide: toStr(raw.slide),
        readFrom: readFroms.includes(raw.readFrom) ? raw.readFrom : value !== null ? 'text' : null,
        evidence: toStr(raw.evidence),
        low: toNum(raw.low),
        high: toNum(raw.high),
      };
    }

    const out: MapperOutput = {
      currency: toStr(data?.currency) || 'Unknown',
      pricingStrategy: {
        value: toStr(data?.pricingStrategy?.value),
        slide: toStr(data?.pricingStrategy?.slide),
        evidence: toStr(data?.pricingStrategy?.evidence),
      },
      moatEvidence: toStr(data?.moatEvidence),
      fields,
    };

    trace?.log('field-mapper', `Mapped candidates (${model})`, {
      found: FIELD_NAMES.filter((n) => fields[n].value !== null),
      missing: FIELD_NAMES.filter((n) => fields[n].value === null),
      currency: out.currency,
    });
    return out;
  }
}

// ==================== Moat classifier (fixed taxonomy) ====================

export interface MoatEvidence {
  type: MoatType;
  stated: boolean; // true = the deck explicitly claims it; false = inferred from the product description
  slide: string | null;
  evidence: string;
}

export interface MoatResult {
  types: MoatType[];
  provenance: Provenance | null;
  confidence: number;
  source: string;
  evidence: MoatEvidence[];
  thinWrapperRisk: 'low' | 'medium' | 'high' | 'unknown';
}

export const EMPTY_MOAT: MoatResult = {
  types: [],
  provenance: null,
  confidence: 0,
  source: 'not found',
  evidence: [],
  thinWrapperRisk: 'unknown',
};

/** Classifies defensibility into the FIXED taxonomy so results are comparable across startups. */
export class MoatClassifier {
  private gemini: GeminiClient;

  constructor() {
    this.gemini = getGeminiClient();
  }

  public async classify(
    doc: NormalizedDoc,
    mapper: MapperOutput,
    input: AgentInput,
    trace?: TraceLogger
  ): Promise<MoatResult> {
    const prompt = `
      You are a VC associate classifying a startup's defensibility.
      Company: ${input.startup_name} | category: ${input.category} | stage: ${input.stage} | sector: ${input.sector}

      Allowed moat types (use ONLY these exact strings, at most 3):
      ${MOAT_TAXONOMY.map((m) => `- ${m}`).join('\n      ')}

      Rules:
      - Include a type only if the document supports it. For each, set "stated": true if the deck explicitly CLAIMS that kind of defensibility, or false if you are inferring it from the product description.
      - Do not infer a moat from generic claims ("AI-powered", "novel approach") with no mechanism behind them. If nothing is supported, return an empty "moats" array.
      - "evidence" is a short paraphrase (max 25 words) of what in the deck supports the type.
      - "thinWrapperRisk": how easily could a generic frontier LLM plus a prompt/agent workflow replicate this product? "low" | "medium" | "high".

      What the deck itself says about defensibility (from an earlier pass): ${mapper.moatEvidence ?? 'nothing stated'}

      Return ONLY JSON:
      {
        "moats": [{ "type": "one of the allowed strings", "stated": true, "slide": "Slide N"|null, "evidence": "string" }],
        "thinWrapperRisk": "low|medium|high"
      }

      DOCUMENT:
      ${renderNormalizedDoc(doc, 60000)}
    `;

    const { data, model } = await this.gemini.generateJson<any>('MoatClassifier', [{ text: prompt }], {
      temperature: 0.1,
    });

    const evidence: MoatEvidence[] = (Array.isArray(data?.moats) ? data.moats : [])
      .filter((m: any) => m && (MOAT_TAXONOMY as readonly string[]).includes(m.type) && m.evidence)
      .slice(0, 3)
      .map((m: any) => ({
        type: m.type as MoatType,
        stated: m.stated === true,
        slide: typeof m.slide === 'string' ? m.slide : null,
        evidence: String(m.evidence),
      }));

    const types = Array.from(new Set(evidence.map((e) => e.type)));
    const risk = ['low', 'medium', 'high'].includes(data?.thinWrapperRisk) ? data.thinWrapperRisk : 'unknown';

    // Extracted only if EVERY returned moat is explicitly claimed in the deck; otherwise inferred.
    const provenance: Provenance | null =
      types.length === 0 ? null : evidence.every((e) => e.stated) ? 'extracted' : 'inferred';

    const result: MoatResult = {
      types,
      provenance,
      confidence: provenance ? scoreConfidence(provenance, 'text') : 0,
      source: types.length
        ? `moat classifier (${evidence.map((e) => e.slide).filter(Boolean).join(', ') || 'slides not identified'})`
        : 'not found',
      evidence,
      thinWrapperRisk: risk,
    };

    trace?.log('moat', `Classified (${model})`, { types, provenance, thinWrapperRisk: risk, evidence });
    return result;
  }
}

// ==================== Narrative (summary + extra flags) ====================

/**
 * Narrative layer only: a 1-3 sentence summary plus a few extra flags.
 * Numbers, provenance and confidence are computed in code, never here.
 * (Viability scoring belongs to the Aggregation Engine, so it is intentionally not produced.)
 */
export class BusinessModelReasoningService {
  private gemini: GeminiClient;

  constructor() {
    this.gemini = getGeminiClient();
  }

  private describe(metrics: ResolvedMetrics) {
    const out: Record<string, any> = {};
    for (const [k, m] of Object.entries(metrics)) {
      out[k] = { value: m.value, provenance: m.provenance, confidence: m.confidence, source: m.source };
    }
    return out;
  }

  /** Deterministic fallback so the agent still returns a summary if Gemini is unavailable. */
  public fallbackSummary(metrics: ResolvedMetrics, moat: MoatResult, flags: AgentFlag[]): string {
    const resolved = Object.values(metrics).filter((m) => m.value !== null).length;
    const high = flags.filter((f) => f.severity === 'HIGH').length;
    const bench = Object.values(metrics).filter((m) => m.provenance === 'benchmarked').length;
    return (
      `${resolved} of 4 unit-economics metrics were resolved (${bench} benchmarked); ` +
      `moat classification: ${moat.types.length ? moat.types.join(', ') : 'none supported by the deck'}. ` +
      `${high} high-severity flag(s) raised.`
    );
  }

  public async narrate(
    input: AgentInput,
    metrics: ResolvedMetrics,
    mapper: MapperOutput,
    moat: MoatResult,
    ruleFlags: AgentFlag[]
  ): Promise<{ summary: string; extraFlags: AgentFlag[] }> {
    const prompt = `
      You are a Principal VC Associate writing the business-model section of a diligence report.
      Company: ${input.startup_name} | category: ${input.category} | stage: ${input.stage} | sector: ${input.sector}

      Ground rules:
      - Use ONLY the data below. Do not invent figures, costs or company facts. Do not do your own arithmetic.
      - Where you infer something the data does not state, phrase it as a question to verify, not as a fact.
      - Do not give an invest/pass verdict and do not give a numeric score.
      - Respect provenance: say plainly when a number is benchmarked or derived rather than stated.

      Resolved metrics (currency: ${mapper.currency}):
      ${JSON.stringify(this.describe(metrics), null, 2)}

      Pricing: ${mapper.pricingStrategy.value ?? 'not stated'}
      Moat types: ${moat.types.join(', ') || 'none supported'} (provenance: ${moat.provenance ?? 'n/a'}, thin-wrapper risk: ${moat.thinWrapperRisk})
      Moat evidence: ${JSON.stringify(moat.evidence)}

      Flags already raised in these categories (do NOT repeat them): ${JSON.stringify(ruleFlags.map((f) => f.category))}

      Return ONLY JSON:
      {
        "summary": "1-3 plain-language sentences covering the unit economics and how much of it is stated vs derived/benchmarked",
        "extraFlags": [
          { "severity": "HIGH|MEDIUM|LOW", "category": "string", "issue": "string", "recommendation": "string" }
        ]
      }
      At most 3 extra flags, and only for genuinely new insights (e.g. moat weaknesses the rules cannot see, B2B/B2G channel realism, pricing-model risks grounded in the data above).
    `;

    const { data } = await this.gemini.generateJson<any>('Reasoning', [{ text: prompt }], { temperature: 0.2 });

    const severities: Severity[] = ['HIGH', 'MEDIUM', 'LOW'];
    const covered = ruleFlags.map((f) => f.category.toLowerCase());
    const topicOverlap = (cat: string) => {
      const c = cat.toLowerCase();
      return covered.some(
        (x) =>
          x === c ||
          ['payback', 'cac', 'margin', 'runway', 'growth', 'scale', 'moat', 'wrapper', 'pricing'].some(
            (t) => x.includes(t) && c.includes(t)
          )
      );
    };

    const extraFlags: AgentFlag[] = (Array.isArray(data?.extraFlags) ? data.extraFlags : [])
      .filter((f: any) => f && f.issue && f.category && !topicOverlap(String(f.category)))
      .slice(0, 3)
      .map((f: any) => ({
        severity: severities.includes(f.severity) ? f.severity : 'MEDIUM',
        category: String(f.category),
        issue: String(f.issue),
        recommendation: String(f.recommendation || ''),
      }));

    const summary = typeof data?.summary === 'string' && data.summary.trim() ? data.summary.trim() : '';
    return { summary, extraFlags };
  }
}