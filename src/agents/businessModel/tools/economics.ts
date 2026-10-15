import fs from 'fs';
import path from 'path';
import type { MoatResult } from '.tools/llmSteps';
import {
  AgentFlag,
  DerivationStep,
  ExtractionMethod,
  FIELD_NAMES,
  FieldCandidate,
  FieldName,
  MapperOutput,
  MetricKey,
  Provenance,
  Quantity,
  ResolvedInputs,
  ResolvedMetric,
  ResolvedMetrics,
  scoreConfidence,
  TraceLogger,
} from './types';

// ==================== Benchmark fallback ====================

export type BenchmarkMetric = 'cac' | 'ltv' | 'payback_period_months' | 'gross_margin_pct';

export interface BenchmarkEntry {
  sector: string; // e.g. "saas", "marketplace", "hardware"
  stage: string; // e.g. "pre-seed", "seed"; "*" matches any stage for that sector
  metric: BenchmarkMetric;
  value: number;
  low?: number;
  high?: number;
  source: string; // where the number came from (report, dataset, licence)
  asOf: string; // e.g. "2026-Q1", used to spot stale entries
}

export interface BenchmarkHit {
  entry: BenchmarkEntry;
  value: number;
  range: { low: number; high: number } | null;
  label: string;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s\-/]+/g, '_');

/**
 * Sector + stage keyed lookup. Deliberately NO cross-sector fallback:
 * a generic table produces misleading values. If nothing matches, the field stays unresolved.
 * Dataset file: data/benchmarks.json (override with BENCHMARK_FILE). You must source the numbers.
 */
export class BenchmarkProvider {
  private entries: BenchmarkEntry[] | null = null;
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || process.env.BENCHMARK_FILE || path.join(process.cwd(), 'data', 'benchmarks.json');
  }

  private load(): BenchmarkEntry[] {
    if (this.entries) return this.entries;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      this.entries = Array.isArray(raw?.entries) ? raw.entries : [];
    } catch (err: any) {
      console.warn(`[Benchmarks] Could not load ${this.filePath} (${err?.code || err?.message}). Benchmark fallback disabled.`);
      this.entries = [];
    }
    return this.entries as BenchmarkEntry[];
  }

  lookup(sector: string, stage: string, metric: BenchmarkMetric): BenchmarkHit | null {
    const sectorKey = norm(sector);
    const stageKey = norm(stage);
    const candidates = this.load().filter((e) => e.metric === metric && norm(e.sector) === sectorKey);

    const entry =
      candidates.find((e) => norm(e.stage) === stageKey) || candidates.find((e) => e.stage.trim() === '*');
    if (!entry || !Number.isFinite(entry.value) || entry.value <= 0 || /^REPLACE/i.test(entry.source)) return null;

    const range =
      Number.isFinite(entry.low) && Number.isFinite(entry.high)
        ? { low: entry.low as number, high: entry.high as number }
        : null;

    return {
      entry,
      value: entry.value,
      range,
      label: `${entry.sector}/${entry.stage}: ${entry.source} (as of ${entry.asOf})`,
    };
  }
}

// ==================== Unit economics reasoning chain ====================

const BENCH_KEY: Record<MetricKey, BenchmarkMetric> = {
  cac: 'cac',
  ltv: 'ltv',
  paybackPeriodMonths: 'payback_period_months',
  grossMarginPct: 'gross_margin_pct',
};

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

interface Derived {
  value: number;
  steps: DerivationStep[];
  inputs: Quantity[];
  inputNames: string[];
  notes: string[];
}

function fromCandidate(c: FieldCandidate): Quantity | null {
  if (c.value === null || !Number.isFinite(c.value)) return null;
  const method: ExtractionMethod = c.readFrom ?? 'text';
  return {
    value: c.value,
    provenance: 'extracted',
    confidence: scoreConfidence('extracted', method),
    source: c.slide ?? 'deck (slide not identified)',
    method,
    range: c.low !== null && c.high !== null ? { low: c.low, high: c.high } : null,
  };
}

function asQuantity(m: ResolvedMetric): Quantity | null {
  if (m.value === null || m.provenance === null) return null;
  return {
    value: m.value,
    provenance: m.provenance,
    confidence: m.confidence,
    source: m.source,
    method: m.method ?? 'derived',
    range: m.range,
  };
}

/**
 * Per-field decision tree: extracted -> derivable from adjacent fields -> sector/stage benchmark -> unresolved.
 * Each field is resolved independently so provenance and confidence stay honest per field.
 * Every derivation step is logged to the trace.
 */
export class UnitEconomicsChain {
  constructor(private benchmarks: BenchmarkProvider) {}

  // ----- derivations -----
  private deriveGrossMargin(i: ResolvedInputs): Derived | null {
    const price = i.pricePerUnit;
    const cogs = i.cogsPerUnit;
    if (price && cogs && price.value > 0) {
      const gm = round(((price.value - cogs.value) / price.value) * 100);
      return {
        value: gm,
        inputs: [price, cogs],
        inputNames: ['pricePerUnit', 'cogsPerUnit'],
        notes: [],
        steps: [
          {
            step: 1,
            description: 'Gross margin from unit price and unit COGS',
            formula: '(price - cogs_per_unit) / price x 100',
            inputs: { price: price.value, cogs_per_unit: cogs.value },
            result: gm,
          },
        ],
      };
    }

    const rev = i.year1Revenue;
    const cogsTotal = i.year1Cogs;
    const gp = i.year1GrossProfit;
    if (rev && rev.value > 0 && (cogsTotal || gp)) {
      const grossProfit = gp ? gp.value : rev.value - (cogsTotal as Quantity).value;
      const gm = round((grossProfit / rev.value) * 100);
      return {
        value: gm,
        inputs: [rev, (gp || cogsTotal) as Quantity],
        inputNames: ['year1Revenue', gp ? 'year1GrossProfit' : 'year1Cogs'],
        notes: [],
        steps: [
          {
            step: 1,
            description: 'Gross margin from Year 1 P&L',
            formula: 'gross_profit / revenue x 100',
            inputs: { revenue: rev.value, gross_profit: grossProfit },
            result: gm,
          },
        ],
      };
    }
    return null;
  }

  private deriveCac(i: ResolvedInputs): Derived | null {
    const spend = i.marketingSpend;
    const customers = i.newCustomers;
    if (!spend || !customers || customers.value <= 0) return null;
    const cac = round(spend.value / customers.value);
    return {
      value: cac,
      inputs: [spend, customers],
      inputNames: ['marketingSpend', 'newCustomers'],
      notes: ['Marketing spend and new customers must cover the same period.'],
      steps: [
        {
          step: 1,
          description: 'CAC from acquisition spend and new customers',
          formula: 'marketing_spend / new_customers',
          inputs: { marketing_spend: spend.value, new_customers: customers.value },
          result: cac,
        },
      ],
    };
  }

  private deriveLtv(i: ResolvedInputs, gm: Quantity | null): Derived | null {
    const arpu = i.arpuMonthly;
    if (!arpu) return null;

    const steps: DerivationStep[] = [];
    const inputs: Quantity[] = [arpu];
    const names = ['arpuMonthly'];
    const notes: string[] = [];

    let lifetime: number | null = null;
    if (i.customerLifetimeMonths) {
      lifetime = i.customerLifetimeMonths.value;
      inputs.push(i.customerLifetimeMonths);
      names.push('customerLifetimeMonths');
    } else if (i.monthlyChurnPct && i.monthlyChurnPct.value > 0) {
      lifetime = round(100 / i.monthlyChurnPct.value);
      inputs.push(i.monthlyChurnPct);
      names.push('monthlyChurnPct');
      steps.push({
        step: steps.length + 1,
        description: 'Customer lifetime from monthly churn',
        formula: '100 / monthly_churn_pct',
        inputs: { monthly_churn_pct: i.monthlyChurnPct.value },
        result: lifetime,
      });
    }
    if (lifetime === null || lifetime <= 0) return null;

    let ltv = arpu.value * lifetime;
    let formula = 'arpu_monthly x lifetime_months';
    if (gm) {
      ltv = ltv * (gm.value / 100);
      formula += ' x gross_margin';
      inputs.push(gm);
      names.push('grossMarginPct');
    } else {
      notes.push('LTV is revenue-based (not margin-adjusted) because gross margin was unavailable.');
    }
    ltv = round(ltv);

    steps.push({
      step: steps.length + 1,
      description: 'Lifetime value',
      formula,
      inputs: { arpu_monthly: arpu.value, lifetime_months: lifetime, gross_margin_pct: gm ? gm.value : null },
      result: ltv,
    });
    return { value: ltv, steps, inputs, inputNames: names, notes };
  }

  private derivePayback(i: ResolvedInputs, cac: Quantity | null, gm: Quantity | null): Derived | null {
    const arpu = i.arpuMonthly;
    if (!cac || !arpu || !gm) return null;
    const monthlyContribution = arpu.value * (gm.value / 100);
    if (monthlyContribution <= 0) return null;
    const months = round(cac.value / monthlyContribution);
    return {
      value: months,
      inputs: [cac, arpu, gm],
      inputNames: ['cac', 'arpuMonthly', 'grossMarginPct'],
      notes: [],
      steps: [
        {
          step: 1,
          description: 'Monthly gross contribution per customer',
          formula: 'arpu_monthly x gross_margin',
          inputs: { arpu_monthly: arpu.value, gross_margin_pct: gm.value },
          result: round(monthlyContribution),
        },
        {
          step: 2,
          description: 'Payback period in months',
          formula: 'cac / monthly_contribution',
          inputs: { cac: cac.value, monthly_contribution: round(monthlyContribution) },
          result: months,
        },
      ],
    };
  }

  // ----- resolution -----
  private resolveMetric(
    key: MetricKey,
    extracted: Quantity | null,
    derive: () => Derived | null,
    ctx: { sector: string; stage: string },
    trace: TraceLogger
  ): ResolvedMetric {
    if (extracted) {
      trace.log('unit-economics', `${key}: EXTRACTED`, {
        value: extracted.value,
        source: extracted.source,
        method: extracted.method,
      });
      return {
        value: extracted.value,
        provenance: 'extracted',
        confidence: extracted.confidence,
        source: extracted.source,
        method: extracted.method,
        range: extracted.range,
        derivation: [],
        notes: [],
      };
    }

    const d = derive();
    if (d) {
      const provenance: Provenance = d.inputs.some((q) => q.provenance === 'benchmarked') ? 'benchmarked' : 'inferred';
      // A derived value can never be more confident than its weakest input.
      const confidence = round(
        Math.min(scoreConfidence(provenance, 'derived'), ...d.inputs.map((q) => q.confidence))
      );
      trace.log('unit-economics', `${key}: ${provenance.toUpperCase()} (derived)`, {
        value: d.value,
        inputs: d.inputNames,
        steps: d.steps,
      });
      return {
        value: d.value,
        provenance,
        confidence,
        source: `derived from ${d.inputNames.join(', ')}`,
        method: 'derived',
        range: null,
        derivation: d.steps,
        notes: d.notes,
      };
    }

    const hit = this.benchmarks.lookup(ctx.sector, ctx.stage, BENCH_KEY[key]);
    if (hit) {
      trace.log('unit-economics', `${key}: BENCHMARKED`, { value: hit.value, set: hit.label });
      return {
        value: hit.value,
        provenance: 'benchmarked',
        confidence: scoreConfidence('benchmarked', 'benchmark'),
        source: `benchmark: ${hit.label}`,
        method: 'benchmark',
        range: hit.range,
        derivation: [],
        notes: [],
      };
    }

    trace.log('unit-economics', `${key}: UNRESOLVED (not stated, not derivable, no benchmark)`);
    return {
      value: null,
      provenance: null,
      confidence: 0,
      source: 'not found',
      method: null,
      range: null,
      derivation: [],
      notes: [],
    };
  }

  public resolve(
    mapper: MapperOutput,
    ctx: { sector: string; stage: string },
    trace: TraceLogger
  ): { metrics: ResolvedMetrics; inputs: ResolvedInputs } {
    const inputs = {} as ResolvedInputs;
    for (const name of FIELD_NAMES) inputs[name as FieldName] = fromCandidate(mapper.fields[name]);

    // Order matters: payback needs CAC and gross margin; LTV needs gross margin.
    const grossMarginPct = this.resolveMetric(
      'grossMarginPct',
      inputs.grossMarginPct,
      () => this.deriveGrossMargin(inputs),
      ctx,
      trace
    );
    const gmQ = asQuantity(grossMarginPct);

    const cac = this.resolveMetric('cac', inputs.cac, () => this.deriveCac(inputs), ctx, trace);
    const cacQ = asQuantity(cac);

    const ltv = this.resolveMetric('ltv', inputs.ltv, () => this.deriveLtv(inputs, gmQ), ctx, trace);
    const paybackPeriodMonths = this.resolveMetric(
      'paybackPeriodMonths',
      inputs.paybackPeriodMonths,
      () => this.derivePayback(inputs, cacQ, gmQ),
      ctx,
      trace
    );

    return { metrics: { cac, ltv, paybackPeriodMonths, grossMarginPct }, inputs };
  }
}

// ==================== Deterministic flags ====================

const LABELS: Record<MetricKey, string> = {
  cac: 'CAC',
  ltv: 'LTV',
  paybackPeriodMonths: 'Payback period',
  grossMarginPct: 'Gross margin',
};

export function formatFlag(f: AgentFlag): string {
  return `[${f.severity}] ${f.category}: ${f.issue} Recommendation: ${f.recommendation}`;
}

const v = (q: { value: number } | null | undefined): number | null => (q ? q.value : null);

/** Deterministic flags: provenance, plus the P&L / unit-economics stress tests. */
export function buildRuleFlags(
  metrics: ResolvedMetrics,
  inputs: ResolvedInputs,
  mapper: MapperOutput,
  moat: MoatResult
): AgentFlag[] {
  const flags: AgentFlag[] = [];

  // ---- Provenance flags (the point of the extracted/inferred/benchmarked distinction) ----
  (Object.keys(LABELS) as MetricKey[]).forEach((key) => {
    const m = metrics[key];
    const label = LABELS[key];

    if (m.provenance === 'benchmarked') {
      flags.push({
        severity: 'HIGH',
        category: `${label} Provenance`,
        issue: `${label} is benchmarked, not stated: the deck has no usable figure, so this value comes from ${m.source}. It does not describe this startup.`,
        recommendation: 'Obtain the real figure from the founders before any downstream scenario modelling.',
      });
    } else if (m.provenance === 'inferred') {
      flags.push({
        severity: 'MEDIUM',
        category: `${label} Provenance`,
        issue: `${label} is derived, not stated (${m.source}). Its accuracy depends on the inputs it was derived from.${m.notes.length ? ' ' + m.notes.join(' ') : ''}`,
        recommendation: 'Review the derivation steps in the trace and confirm the inputs with the founders.',
      });
    } else if (m.provenance === null) {
      flags.push({
        severity: 'MEDIUM',
        category: `${label} Missing`,
        issue: `${label} is not stated in the deck, cannot be derived from other figures, and no benchmark exists for this sector and stage.`,
        recommendation: 'Request this metric from the founders.',
      });
    } else if (m.method === 'chart') {
      flags.push({
        severity: 'LOW',
        category: `${label} Chart Read`,
        issue: `${label} was read off a chart (${m.source}), so treat it as approximate${m.range ? ` (estimated range ${m.range.low} to ${m.range.high})` : ''}.`,
        recommendation: 'Confirm the exact figure with the founders.',
      });
    }
  });

  if (!mapper.pricingStrategy.value) {
    flags.push({
      severity: 'MEDIUM',
      category: 'Pricing Missing',
      issue: 'The deck does not describe how the product is priced.',
      recommendation: 'Request the pricing model and price points.',
    });
  }

  // ---- Payback realism ----
  const price = v(inputs.pricePerUnit);
  const gm = metrics.grossMarginPct.value;
  const cac = metrics.cac.value;
  const payback = metrics.paybackPeriodMonths.value;

  if (payback !== null && payback < 1) {
    let ratioMatch = false;
    if (price !== null && gm !== null && cac !== null) {
      const contribution = price * (gm / 100) - cac;
      if (contribution > 0) {
        const ratio = cac / contribution;
        ratioMatch = Math.abs(payback - ratio) / ratio < 0.05;
      }
    }
    flags.push({
      severity: 'HIGH',
      category: 'Payback Realism',
      issue:
        `Reported payback of ${payback} months (~${Math.round(payback * 30)} days) is implausibly short for B2B/B2G sales.` +
        (ratioMatch
          ? ' It also matches CAC divided by per-unit contribution, a ratio of units rather than a time-to-recover figure; for pay-per-use it only becomes months if customers repeat purchases on a schedule.'
          : ''),
      recommendation:
        'Recompute payback using realistic sales-cycle length and repeat-purchase frequency, and ask for cohort evidence.',
    });
  }

  // ---- CAC realism ----
  if (cac !== null && price !== null && price > 0 && (cac / price) * 100 <= 10) {
    flags.push({
      severity: 'MEDIUM',
      category: 'CAC Realism',
      issue: `CAC is only ${round((cac / price) * 100)}% of price per unit. B2B/B2G sales usually involve long cycles, pilots and sales effort that a figure this low may not include.`,
      recommendation: 'Break CAC down into marketing, sales salaries, pilots and onboarding, and validate it against pilot data.',
    });
  }

  // ---- Gross margin cross-check: stated vs Year 1 P&L ----
  const rev = v(inputs.year1Revenue);
  const gpDeck = v(inputs.year1GrossProfit) ?? (rev !== null && v(inputs.year1Cogs) !== null ? rev - (v(inputs.year1Cogs) as number) : null);
  const actualGm = rev && gpDeck !== null ? round((gpDeck / rev) * 100) : null;
  if (actualGm !== null && gm !== null && Math.abs(gm - actualGm) >= 1) {
    flags.push({
      severity: 'MEDIUM',
      category: 'Margin Discrepancy',
      issue: `Gross margin is ${gm}% in the headline, but the deck's own Year 1 figures give ${actualGm}% (gap of ${round(gm - actualGm)} points).`,
      recommendation: 'Reconcile the headline margin with the Year 1 P&L and explain what drives the difference.',
    });
  }

  // ---- Operating margin sanity ----
  const op = v(inputs.year1OperatingProfit);
  const opexDeck = v(inputs.year1Opex) ?? (gpDeck !== null && op !== null ? gpDeck - op : null);
  if (rev && op !== null) {
    const opMargin = round((op / rev) * 100);
    if (opMargin >= 40 && (actualGm ?? gm ?? 0) >= 70) {
      flags.push({
        severity: 'MEDIUM',
        category: 'Margin Sanity',
        issue: `A ${opMargin}% Year 1 operating margin is unusually high for an early-stage venture.${
          opexDeck !== null ? ` Year 1 opex is ${round(opexDeck, 0)} (about ${round((opexDeck / rev) * 100)}% of revenue, roughly ${round(opexDeck / 12, 0)} per month).` : ''
        }`,
        recommendation: 'Itemise opex (team, cloud/LLM costs, compliance, sales) and confirm founder salaries and infrastructure are costed.',
      });
    }
  }

  // ---- Scale and growth ----
  if (rev && price && price > 0 && rev / price < 500) {
    flags.push({
      severity: 'LOW',
      category: 'Revenue Scale',
      issue: `Year 1 revenue implies only about ${round(rev / price, 1)} paid units, so the plan is sensitive to a handful of customers.`,
      recommendation: 'Show a named pipeline and conversion assumptions behind early unit volumes.',
    });
  }

  const growth = v(inputs.monthlyGrowthPct);
  if (growth !== null) {
    const multiple = round(Math.pow(1 + growth / 100, 11));
    if (multiple >= 2.5) {
      flags.push({
        severity: 'LOW',
        category: 'Growth Assumption',
        issue: `${growth}% monthly growth compounds to about ${multiple}x volume between month 1 and month 12 and needs a repeatable acquisition channel.`,
        recommendation: 'Support the growth rate with pipeline data or comparable early-stage benchmarks.',
      });
    }
  }

    // ---- Runway ----
  const cash = v(inputs.cashBalance);
  const burn = v(inputs.monthlyBurn);
  if (cash !== null && burn !== null && burn > 0) {
    const runway = round(cash / burn, 1);
    if (runway < 12) {
      flags.push({
        severity: runway < 6 ? 'HIGH' : 'MEDIUM',
        category: 'Runway',
        issue: `Runway is about ${runway} months (cash ${cash} / burn ${burn}).`,
        recommendation: 'Plan a raise or cost reduction so runway comfortably exceeds the time to the next milestone.',
      });
    }
  } else if (cash === null || burn === null) {
    flags.push({
      severity: 'LOW',
      category: 'Runway',
      issue: 'Runway cannot be calculated because cash on hand and monthly burn are not stated in the deck.',
      recommendation: 'Request the current cash balance and burn rate.',
    });
  }

  // ---- Moat ----
  if (moat.types.length === 0) {
    flags.push({
      severity: 'MEDIUM',
      category: 'Moat Missing',
      issue: 'The deck does not support any defensibility type from the fixed taxonomy.',
      recommendation: 'Ask what stops a competitor, or a generic LLM, from replicating the product.',
    });
  } else if (moat.provenance === 'inferred') {
    flags.push({
      severity: 'LOW',
      category: 'Moat Inferred',
      issue: `Defensibility (${moat.types.join(', ')}) was inferred from the product description, not claimed by the deck.`,
      recommendation: 'Ask the founders to state and evidence their moat.',
    });
  }
  if (moat.thinWrapperRisk === 'high') {
    flags.push({
      severity: 'HIGH',
      category: 'Thin-Wrapper Risk',
      issue: 'The product looks replicable by a generic frontier LLM plus an agent/prompt workflow.',
      recommendation: 'Ask what proprietary data, integrations or switching costs a competitor could not copy quickly.',
    });
  }

  return flags;
}