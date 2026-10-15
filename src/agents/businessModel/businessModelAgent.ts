import { BenchmarkProvider, UnitEconomicsChain, buildRuleFlags, formatFlag } from './tools/Economics';
import { IngestionService } from './tools/ingestion';

import {
  BusinessModelReasoningService,
  EMPTY_MOAT,
  FieldMapperService,
  MoatClassifier,
  MoatResult,
} from './tools/llmSteps';
import {
  AgentFlag,
  AgentInput,
  AgentOutput,
  MetricOutput,
  ResolvedMetric,
  rollupConfidence,
  rollupSourceType,
  TraceLogger,
} from './tools/types';

const order = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;

const metricOut = (m: ResolvedMetric): MetricOutput<number> => ({
  value: m.value,
  provenance: m.provenance,
  confidence: m.confidence,
  source: m.source,
  ...(m.range ? { range: m.range } : {}),
  ...(m.derivation.length ? { derivation_steps: m.derivation } : {}),
  ...(m.notes.length ? { notes: m.notes } : {}),
});

const emptyMetric = <T>(): MetricOutput<T> => ({ value: null, provenance: null, confidence: 0, source: 'not found' });

/**
 * Business Model Agent: ingestion -> field mapping -> per-field unit-economics resolution
 * -> moat classification -> deterministic confidence -> structured output (shared subagent schema).
 */
export class BusinessModelAgent {
  private ingestion = new IngestionService();
  private mapper = new FieldMapperService();
  private chain = new UnitEconomicsChain(new BenchmarkProvider());
  private moatClassifier = new MoatClassifier();
  private reasoning = new BusinessModelReasoningService();

  public async run(input: AgentInput): Promise<AgentOutput> {
    const trace = new TraceLogger();
    trace.log('agent', 'Run started', { startup: input.startup_name, stage: input.stage, sector: input.sector });

    try {
      // 1. Ingestion + normalization (provenance-tagged)
      const doc = await this.ingestion.extractAndNormalize(input.document, trace);

      // 2. Field mapping (explicitly stated values only)
      const mapped = await this.mapper.mapFields(doc, input, trace);

      // 3. Per-field resolution: extracted -> derived -> benchmark
      const { metrics, inputs } = this.chain.resolve(mapped, { sector: input.sector, stage: input.stage }, trace);

      // 4. Moat classification (non-fatal)
      let moat: MoatResult = EMPTY_MOAT;
      let moatFailed = false;
      try {
        moat = await this.moatClassifier.classify(doc, mapped, input, trace);
      } catch (err: any) {
        moatFailed = true;
        console.error('[Agent] Moat classification failed:', err);
        trace.log('moat', 'Classification failed', { error: err?.message || String(err) });
      }

      // 5. Deterministic flags, then narrative (non-fatal)
      const ruleFlags = buildRuleFlags(metrics, inputs, mapped, moat).filter(
  (f) => !(moatFailed && f.category === 'Moat Missing')
);
      // A stated value that fails a realism check is "extracted" but not trustworthy.
      // Cap its confidence BEFORE the rollup so the overall score reflects it.
      if (ruleFlags.some((f) => f.category === 'Payback Realism')) {
        const p = metrics.paybackPeriodMonths;
        p.confidence = Math.min(p.confidence, 0.4);
        p.notes.push('Stated value failed a realism check; treat as unreliable.');
        trace.log('agent', 'Payback confidence capped after realism flag', { confidence: p.confidence });
      }

      const allFlags: AgentFlag[] = [...ruleFlags];

      let summary = '';
      let narrativeFailed = false;
      try {
        const narrative = await this.reasoning.narrate(input, metrics, mapped, moat, ruleFlags);
        allFlags.push(
  ...narrative.extraFlags.filter((f) => !(moatFailed && /moat|defensib|wrapper/i.test(f.category)))
);
        summary = narrative.summary;
      } catch (err: any) {
        narrativeFailed = true;
        console.error('[Agent] Narrative generation failed:', err);
        trace.log('reasoning', 'Narrative failed', { error: err?.message || String(err) });
      }
      if (!summary) summary = this.reasoning.fallbackSummary(metrics, moat, ruleFlags);

      if (!doc.visionSucceeded && doc.sourcesUsed[0] !== 'text-blob') {
        allFlags.push({
          severity: 'MEDIUM',
          category: 'Vision Pass Skipped',
          issue: 'The chart/image extraction pass failed, so figures that appear only in graphs may be missing.',
          recommendation: 'Re-run the analysis, or supply the figures manually.',
        });
      }
      if (moatFailed) {
        allFlags.push({
          severity: 'LOW',
          category: 'Moat Classification Failed',
          issue: 'The moat classifier call failed, so defensibility was not assessed.',
          recommendation: 'Re-run the analysis.',
        });
      }
      allFlags.sort((a, b) => order[a.severity] - order[b.severity]);

      // 6. Pricing and moat as output metrics
      const pricing: MetricOutput<string> = mapped.pricingStrategy.value
        ? {
            value: mapped.pricingStrategy.value,
            provenance: 'extracted',
            confidence: 0.9,
            source: mapped.pricingStrategy.slide ?? 'deck',
          }
        : emptyMetric<string>();

      const moatMetric: MetricOutput<any> = {
        value: moat.types.length ? moat.types : null,
        provenance: moat.provenance,
        confidence: moat.confidence,
        source: moat.source,
      };

      // 7. Deterministic rollups
      const anyMissing =
        Object.values(metrics).some((m) => m.value === null) || pricing.value === null;

      const confidence = rollupConfidence({
        cac: metrics.cac.confidence,
        ltv: metrics.ltv.confidence,
        payback_period_months: metrics.paybackPeriodMonths.confidence,
        gross_margin_pct: metrics.grossMarginPct.confidence,
        pricing_strategy: pricing.confidence,
        moat_type: moat.confidence,
      });

      let sourceType = rollupSourceType([
        metrics.cac.provenance,
        metrics.ltv.provenance,
        metrics.paybackPeriodMonths.provenance,
        metrics.grossMarginPct.provenance,
        pricing.provenance,
        moat.provenance,
      ]);
      // Never report 'verified' when a metric is missing or a HIGH-severity flag exists.
      if (sourceType === 'verified' && (anyMissing || allFlags.some((f) => f.severity === 'HIGH'))) {
        sourceType = 'inferred';
      }

      const usedBenchmark = Object.values(metrics).some((m) => m.provenance === 'benchmarked');
      const sourcesUsed = [
        ...doc.sourcesUsed,
        'gemini-field-mapper',
        'unit-economics-chain',
        ...(usedBenchmark ? ['benchmark-dataset'] : []),
        ...(moatFailed ? [] : ['gemini-moat-classifier']),
        ...(narrativeFailed ? [] : ['gemini-reasoning']),
      ];

      const status: AgentOutput['status'] =
        anyMissing || moatFailed || narrativeFailed || (!doc.visionSucceeded && doc.sourcesUsed[0] !== 'text-blob')
          ? 'partial'
          : 'success';

      trace.log('agent', 'Run finished', { status, confidence, sourceType });
      const traceId = await trace.save();

      return {
        agent_name: 'business_model',
        status,
        findings: {
          summary,
          metrics: {
            cac: metricOut(metrics.cac),
            ltv: metricOut(metrics.ltv),
            payback_period_months: metricOut(metrics.paybackPeriodMonths),
            gross_margin_pct: metricOut(metrics.grossMarginPct),
            pricing_strategy: pricing,
            moat_type: moatMetric,
          },
          flags: allFlags.map(formatFlag),
          flags_structured: allFlags,
        },
        confidence,
        source_type: sourceType,
        sources_used: sourcesUsed,
        raw_trace_id: traceId,
      };
    } catch (err: any) {
      console.error('[Agent] Run failed:', err);
      trace.log('agent', 'Run failed', { error: err?.message || String(err) });
      const traceId = await trace.save();
      const flag: AgentFlag = {
        severity: 'HIGH',
        category: 'Agent Failure',
        issue: `The business model analysis could not be completed: ${err?.message || String(err)}`,
        recommendation: 'Check the trace, fix the underlying error and re-run.',
      };
      return {
        agent_name: 'business_model',
        status: 'failed',
        findings: {
          summary: 'Analysis failed; no metrics were produced.',
          metrics: {
            cac: emptyMetric(),
            ltv: emptyMetric(),
            payback_period_months: emptyMetric(),
            gross_margin_pct: emptyMetric(),
            pricing_strategy: emptyMetric(),
            moat_type: emptyMetric(),
          },
          flags: [formatFlag(flag)],
          flags_structured: [flag],
        },
        confidence: 0,
        source_type: 'inferred',
        sources_used: [],
        raw_trace_id: traceId,
      };
    }
  }
}