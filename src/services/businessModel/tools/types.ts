import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

// ---------- Shared vocabulary ----------
export type Provenance = 'extracted' | 'inferred' | 'benchmarked';
export type ExtractionMethod = 'text' | 'table' | 'chart' | 'derived' | 'benchmark';
export type ReadFrom = 'text' | 'table' | 'chart';

export const MOAT_TAXONOMY = [
  'network_effects',
  'switching_costs',
  'brand',
  'proprietary_ip_data',
  'economies_of_scale',
] as const;
export type MoatType = (typeof MOAT_TAXONOMY)[number];

// ---------- Input contract (from orchestrator) ----------
export interface AgentInput {
  startup_name: string;
  /** Path to a PDF deck, or a raw extracted-text blob. */
  document: string;
  category: string;
  stage: string; // pre-seed / seed / Series A / ...
  sector: string; // used for benchmark lookup
}

// ---------- Normalized document (output of ingestion) ----------
export interface SourcedText {
  id: string;
  page: number | null;
  text: string;
  source: 'pdf-text' | 'vision' | 'text-blob';
}

export interface SourcedTable {
  id: string;
  slide: string | null;
  title: string;
  headers: string[];
  rows: string[][];
  source: 'vision';
}

export interface SourcedMetric {
  id: string;
  label: string;
  value: number | null;
  low: number | null; // estimate range, mainly for chart reads
  high: number | null;
  unit: string | null;
  slide: string | null;
  readFrom: ReadFrom;
  context: string;
  source: 'vision';
}

export interface NormalizedDoc {
  texts: SourcedText[];
  tables: SourcedTable[];
  metrics: SourcedMetric[];
  sourcesUsed: string[];
  visionSucceeded: boolean;
}

// ---------- Field mapper output ----------
export const FIELD_NAMES = [
  'cac',
  'ltv',
  'paybackPeriodMonths',
  'grossMarginPct',
  'pricePerUnit',
  'arpuMonthly',
  'monthlyChurnPct',
  'customerLifetimeMonths',
  'marketingSpend',
  'newCustomers',
  'cogsPerUnit',
  'year1Revenue',
  'year1Cogs',
  'year1GrossProfit',
  'year1Opex',
  'year1OperatingProfit',
  'monthlyGrowthPct',
  'cashBalance',
  'monthlyBurn',
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

export interface FieldCandidate {
  value: number | null; // null = not stated explicitly in the deck
  unit: string | null;
  slide: string | null;
  readFrom: ReadFrom | null;
  evidence: string | null;
  low: number | null;
  high: number | null;
}

export interface MapperOutput {
  currency: string;
  pricingStrategy: { value: string | null; slide: string | null; evidence: string | null };
  moatEvidence: string | null;
  fields: Record<FieldName, FieldCandidate>;
}

// ---------- Unit economics resolution ----------
export interface Quantity {
  value: number;
  provenance: Provenance;
  confidence: number;
  source: string;
  method: ExtractionMethod;
  range: { low: number; high: number } | null;
}

export interface DerivationStep {
  step: number;
  description: string;
  formula?: string;
  inputs: Record<string, number | string | null>;
  result: number | null;
}

export type MetricKey = 'cac' | 'ltv' | 'paybackPeriodMonths' | 'grossMarginPct';

export interface ResolvedMetric {
  value: number | null;
  provenance: Provenance | null;
  confidence: number;
  source: string;
  method: ExtractionMethod | null;
  range: { low: number; high: number } | null;
  derivation: DerivationStep[];
  notes: string[];
}

export type ResolvedMetrics = Record<MetricKey, ResolvedMetric>;
export type ResolvedInputs = Record<FieldName, Quantity | null>;

// ---------- Flags ----------
export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';
export interface AgentFlag {
  severity: Severity;
  category: string;
  issue: string;
  recommendation: string;
}

// ---------- Output contract (shared subagent schema) ----------
export interface MetricOutput<T> {
  value: T | null;
  provenance: Provenance | null;
  confidence: number;
  source: string;
  notes?: string[];
  // additive fields (not in the base schema); remove if the shared schema is strict
  range?: { low: number; high: number };
  derivation_steps?: DerivationStep[];
}

export interface AgentOutput {
  agent_name: 'business_model';
  status: 'success' | 'partial' | 'failed';
  findings: {
    summary: string;
    metrics: {
      cac: MetricOutput<number>;
      ltv: MetricOutput<number>;
      payback_period_months: MetricOutput<number>;
      gross_margin_pct: MetricOutput<number>;
      pricing_strategy: MetricOutput<string>;
      moat_type: MetricOutput<MoatType[]>;
    };
    flags: string[];
    flags_structured: AgentFlag[]; // additive
  };
  confidence: number;
  source_type: 'verified' | 'inferred' | 'benchmark';
  sources_used: string[];
  raw_trace_id: string;
}

// ==================== Deterministic confidence scoring ====================

/**
 * Deterministic confidence rules (never LLM-rated):
 *   extracted = 0.9, inferred = 0.6, benchmarked = 0.3, minus 0.15 if the value was read off a chart.
 */
const BASE: Record<Provenance, number> = { extracted: 0.9, inferred: 0.6, benchmarked: 0.3 };
const CHART_PENALTY = 0.15;

export function scoreConfidence(provenance: Provenance, method: ExtractionMethod): number {
  const penalty = method === 'chart' ? CHART_PENALTY : 0;
  return Math.round(Math.max(0, BASE[provenance] - penalty) * 100) / 100;
}

/** Centrality of each field to downstream agents. Sums to 1. */
export const METRIC_WEIGHTS = {
  cac: 0.25,
  ltv: 0.2,
  payback_period_months: 0.2,
  gross_margin_pct: 0.2,
  pricing_strategy: 0.05,
  moat_type: 0.1,
} as const;

export type WeightedField = keyof typeof METRIC_WEIGHTS;

/**
 * Rollup: half weighted average (missing fields count as 0), half the weakest present field,
 * so one strong extracted field cannot mask several benchmarked or missing ones.
 */
const CORE_FIELDS: WeightedField[] = ['cac', 'ltv', 'payback_period_months', 'gross_margin_pct'];

export function rollupConfidence(confidences: Record<WeightedField, number>): number {
  const keys = Object.keys(METRIC_WEIGHTS) as WeightedField[];
  const weighted = keys.reduce((sum, k) => sum + METRIC_WEIGHTS[k] * (confidences[k] || 0), 0);
  const present = keys.map((k) => confidences[k]).filter((c) => c > 0);
  if (present.length === 0) return 0;
  const lowest = Math.min(...present);
  let score = 0.5 * weighted + 0.5 * lowest;

  // A missing core metric caps the score: 0.6 for one, 0.5 for two, and so on.
  const missingCore = CORE_FIELDS.filter((k) => !(confidences[k] > 0)).length;
  if (missingCore > 0) score = Math.min(score, 0.6 - 0.1 * (missingCore - 1));

  return Math.round(score * 100) / 100;
}

/** Weakest provenance wins: any benchmarked field makes the agent 'benchmark'. */
export function rollupSourceType(provenances: (Provenance | null)[]): 'verified' | 'inferred' | 'benchmark' {
  const present = provenances.filter((p): p is Provenance => p !== null);
  if (present.includes('benchmarked')) return 'benchmark';
  if (present.includes('inferred') || present.length === 0) return 'inferred';
  return 'verified';
}

// ==================== Trace logging ====================

export interface TraceEvent {
  ts: string;
  stage: string;
  message: string;
  data?: any;
}

/**
 * Collects extraction source, derivation steps and benchmark sets used,
 * then persists them as JSON. The returned id is the output's raw_trace_id.
 * (Swap save() for a Mongo insert when you add persistence.)
 */
export class TraceLogger {
  readonly traceId: string = crypto.randomUUID();
  private events: TraceEvent[] = [];

  log(stage: string, message: string, data?: any): void {
    this.events.push({ ts: new Date().toISOString(), stage, message, data });
    if (process.env.TRACE_VERBOSE === 'true') {
      console.log(`[trace:${stage}] ${message}`);
    }
  }

  getEvents(): TraceEvent[] {
    return this.events;
  }

  async save(): Promise<string> {
    try {
      const dir = process.env.TRACE_DIR || path.join(process.cwd(), '.traces');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, `${this.traceId}.json`),
        JSON.stringify({ traceId: this.traceId, events: this.events }, null, 2),
        'utf-8'
      );
    } catch (err: any) {
      console.warn('[TraceLogger] Could not persist trace:', err?.message || err);
    }
    return this.traceId;
  }
}