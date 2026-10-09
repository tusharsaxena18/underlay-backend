# AI Visibility Agent — LangChain Implementation Specification

Version: 1.0
Purpose: Implementation blueprint for a single LangChain agent with specialized tools, optional internal models, defined input/output contracts, and shared Gemini key rotation.

---

## 1. Objective
Build an `AIVisibilityAgent` sub-agent using LangChain JS/TypeScript as one of seven specialized sub-agents managed by a central Main Orchestrator Agent.

The `AIVisibilityAgent` is responsible for evaluating how external AI systems describe, discover, mention, rank, and characterize a startup, and comparing those responses against verified startup information. Its goal is to measure the startup's visibility, positioning, factual accuracy, sentiment, and competitive representation across supported AI platforms.

The agent operates as a specialized LangChain agent with its own reasoning model and a set of tools that it can invoke to complete its assigned analysis. These tools are internal capabilities of the sub-agent, not independent top-level agents. Depending on the task, a tool may use deterministic TypeScript logic, an external API, the sub-agent's main model instance, or a specialized internal LLM.

The `AIVisibilityAgent` is responsible for:

* Generating relevant, tier-specific queries about the startup, its category, its target audience, and its competitors.
* Executing queries against supported external AI platforms and collecting raw responses.
* Extracting startup mentions, mention positions, sentiment, framing, claims, and citations.
* Cross-referencing extracted claims against verified startup information to identify inaccuracies, contradictions, and outdated representations.
* Tracing cited sources and evaluating consistency across the startup's public information surfaces.
* Comparing startup visibility against competitors when required by the analysis tier.
* Calculating reproducible visibility metrics and producing structured, evidence-backed findings.
* Persisting its results and returning a validated output to the Main Orchestrator Agent.

The Main Orchestrator Agent remains responsible for coordinating all seven sub-agents, managing dependencies between their outputs, and combining their findings into the overall startup evaluation. The `AIVisibilityAgent` must not assume responsibility for the entire system or independently orchestrate other top-level sub-agents.

Its input and output contracts must be explicitly defined so the Main Orchestrator can invoke it consistently, consume its findings, handle partial failures, and integrate its results with those of the other sub-agents. All Gemini requests made by this sub-agent and its tools must use the application's shared key-rotation mechanism whenever they use the common rotating Gemini provider layer.

## 2. Architecture and model ownership

### 2.1 High-level flow

1. Validate startup input and tier.
2. Generate a tier-appropriate query set.
3. Execute queries against supported AI providers.
4. Store raw responses and metadata.
5. Parse mentions, positions, framing, sentiment, and citations.
6. Compare extracted claims with verified ground truth.
7. detect stale/outdated information.
8. Trace cited or likely source pages when configured.
9. Audit consistency across the startup's public surfaces when configured.
10. Run competitor comparisons for Tier 3.
11. Calculate deterministic metrics and composite score.
12. Persist the run and return the final structured report.

### 2.2 Main agent vs tool models

- `AIVisibilityAgent`: owns the primary orchestration model.
- A tool can receive the main model as a dependency when it should use that exact model instance.
- A tool can create/use its own specialized model when a separate prompt, model choice, or workload isolation is useful.
- A tool can be deterministic or API-backed and have no LLM.
- `execute_ai_queries` calls external AI products being measured. These are target systems, not necessarily the agent's reasoning model.
- Avoid LLM calls for arithmetic, schema validation, database persistence, or simple metadata transformations.

Recommended starting allocation:

| Tool | Internal model? | Recommendation |
|---|---|---|
| `generate_queries` | Optional | Start with deterministic templates; optionally use main model for paraphrases |
| `execute_ai_queries` | No internal orchestration LLM required | Calls configured target-provider APIs; each provider has its own client |
| `parse_ai_response` | Yes, optional | Use a fast model for structured extraction at scale |
| `cross_reference_ground_truth` | Optional | Start with deterministic field checks; use a model only for semantic claim comparison |
| `detect_staleness` | Usually no | Compare timestamps/versioned facts deterministically; optional LLM for ambiguous cases |
| `trace_sources` | No | Search API such as SerpAPI, plus deterministic URL/source normalization |
| `audit_consistency` | Optional | Fetch public pages and compare normalized fields; LLM can resolve semantic differences |
| `benchmark_competitors` | No separate model required | Reuses query execution and analysis tools for competitors |
| `calculate_visibility_score` | No | Deterministic TypeScript formula |
| `persist_visibility_run` | No | Database service |
| `validate_startup_input` | No | Zod validation |

### 2.3 Shared Gemini key rotation

The application should have one module-level `GeminiKeyManager` per Node.js process. Every Gemini API request made through the rotating model/provider layer should obtain the next key from that shared manager.

Important requirements:
- Do not create a separate key manager inside each tool.
- Do not consume a key just because a model object is constructed.
- The next key should be selected when a Gemini request is actually sent.
- All tools using the shared rotating Gemini layer participate in the same round-robin sequence.
- This is process-wide only. Multiple Node.js workers/containers have independent counters unless coordinated with a shared service.
- Verify the model wrapper against the installed `@langchain/core` and `@langchain/google-genai` versions. A simple custom `BaseChatModel` wrapper may not automatically support every feature such as tool calling, structured output, streaming, retries, and batch. Implement and test the features actually needed before using the wrapper as the main agent model.
- Never log complete API keys. Log only a key index and, if necessary, a short masked suffix during development.

## 3. Main agent input contract

Use a Zod schema and infer the TypeScript type from it. Suggested shape:

```ts
import { z } from "zod";

export const AIVisibilityInputSchema = z.object({
  startup_name: z.string().min(1),
  icp: z.string().min(1),
  problem_statement: z.string().min(1),
  category: z.string().min(1),
  competitors: z.array(z.string()).default([]),
  ground_truth: z.object({
    product_description: z.string().min(1),
    pricing_model: z.string().min(1),
    founding_year: z.number().int().optional(),
    key_differentiators: z.array(z.string()).default([]),
    current_stage: z.string().min(1),
    website_url: z.string().url().optional(),
    last_verified_at: z.string().datetime().optional()
  }),
  tier: z.enum(["1", "2", "3"]),
  run_id: z.string().optional(),
  requested_at: z.string().datetime().optional()
});
export type AIVisibilityInput = z.infer<typeof AIVisibilityInputSchema>;
```

Input notes:
- `ground_truth` must come from a trusted upstream source or user-confirmed data.
- `last_verified_at` should be recorded so the system can reason about staleness.
- Tier 1 uses a small query subset; Tier 2 uses the full audit; Tier 3 adds competitor benchmarking and longitudinal comparison.
- Never assume unknown ground-truth fields. Represent unavailable values as missing/unknown rather than inventing them.

## 4. Shared output contract

Return a validated structured object. Use a Zod schema for the final output and reject or repair malformed model output before returning it.

```ts
export const AIVisibilityOutputSchema = z.object({
  agent_name: z.literal("ai_visibility"),
  status: z.enum(["success", "partial", "failed"]),
  run_id: z.string().optional(),
  startup_name: z.string(),
  tier: z.enum(["1", "2", "3"]),
  generated_at: z.string().datetime(),
  findings: z.object({
    summary: z.string(),
    metrics: z.object({
      mention_rate_by_model: z.record(z.string(), z.number().min(0).max(1)),
      avg_position_score: z.number().min(0).max(1).optional(),
      accuracy_score: z.number().min(0).max(1).optional(),
      sentiment_score: z.number().min(0).max(1).optional(),
      competitive_fairness_score: z.number().min(0).max(1).optional(),
      composite_visibility_score: z.number().min(0).max(1).optional()
    }),
    flags: z.array(z.object({
      code: z.string(),
      severity: z.enum(["info", "warning", "critical"]),
      message: z.string(),
      evidence_ids: z.array(z.string()).default([])
    })),
    source_trace: z.array(z.object({
      url: z.string().url().optional(),
      title: z.string().optional(),
      provider: z.string().optional(),
      associated_claim: z.string().optional(),
      confidence: z.number().min(0).max(1).optional()
    })),
    consistency_issues: z.array(z.object({
      field: z.string(),
      surfaces: z.array(z.string()),
      description: z.string(),
      severity: z.enum(["low", "medium", "high"])
    }))
  }),
  confidence: z.number().min(0).max(1),
  source_type: z.enum(["verified", "mixed", "unverified"]),
  sources_used: z.array(z.string()),
  raw_trace_id: z.string().optional(),
  limitations: z.array(z.string()).default([])
});
```

Metric convention:
- Normalize every score to `0..1`.
- `mention_rate_by_model` is mentioned-query count divided by successful queries for that provider, not total attempted queries.
- Mark a metric unavailable if there is insufficient data. Do not silently treat missing data as zero.
- `confidence` reflects evidence coverage, provider success, parsing quality, and ground-truth completeness; do not ask the LLM to invent it.

## 5. Tool specifications

Every tool should have:
- a stable name;
- a concise description explaining when to use it;
- a Zod input schema;
- a predictable, serializable output;
- bounded work (query caps, timeout, payload limits);
- explicit errors/partial-result handling;
- no secrets in its input or output.

### Tool 1 — `validate_startup_input`

**Purpose:** Validate and normalize the startup context before the agent performs work.

**Internal model:** No.

**Input:**
```ts
{
  input: AIVisibilityInput
}
```

**Output:**
```ts
{
  valid: boolean,
  normalized_input?: AIVisibilityInput,
  errors: Array<{ path: string, message: string }>
}
```

**Rules:**
- Reject blank required strings, invalid URLs, unsupported tiers, and malformed dates.
- Normalize whitespace and deduplicate competitor names case-insensitively.
- Do not modify facts in ground truth beyond safe normalization.

### Tool 2 — `generate_queries`

**Purpose:** Create a bounded set of questions that reveal how AI systems describe the startup and its market.

**Internal model:** Optional. Prefer deterministic templates first; the main model may be injected for paraphrasing, or a dedicated fast model may be used. Do not require an LLM for the initial version.

**Input:**
```ts
{
  startup_name: string,
  icp: string,
  problem_statement: string,
  category: string,
  competitors: string[],
  tier: "1" | "2" | "3",
  max_queries?: number
}
```

**Output:**
```ts
{
  queries: Array<{
    query_id: string,
    query: string,
    query_type: "direct" | "category_discovery" | "problem_solution" | "competitive",
    target_startup: string,
    target_competitor?: string
  }>,
  count: number
}
```

**Query families:**
- Direct: “What does {startup} do?”, “Who is {startup} for?”
- Category discovery: “What are the leading {category} products for {icp}?”
- Problem/solution: “What tools help {icp} solve {problem_statement}?”
- Competitive: compare startup with named competitors using equivalent prompts.

**Rules:**
- Tier 1: small teaser subset (e.g. 5–10 queries).
- Tier 2: full audit (e.g. 40–80 queries, subject to cost cap).
- Tier 3: full startup query set plus a comparable competitor set.
- Make query sets reproducible where possible and save the exact queries used.
- Never exceed the configured query cap.

### Tool 3 — `execute_ai_queries`

**Purpose:** Execute the query battery against target AI systems and return raw responses with provider metadata.

**Internal model:** No separate orchestration model required. It calls provider APIs directly. Each target provider has its own client/configuration.

**Input:**
```ts
{
  run_id: string,
  queries: Array<{
    query_id: string,
    query: string,
    target_startup: string,
    target_competitor?: string
  }>,
  providers: Array<"openai" | "anthropic" | "gemini" | "perplexity" | "grok">,
  tier: "1" | "2" | "3",
  max_concurrency?: number,
  timeout_ms?: number
}
```

**Output:**
```ts
{
  results: Array<{
    response_id: string,
    run_id: string,
    query_id: string,
    provider: string,
    status: "success" | "error" | "timeout" | "skipped",
    response_text?: string,
    citations?: string[],
    latency_ms?: number,
    error_code?: string,
    captured_at: string
  }>,
  provider_summary: Array<{
    provider: string,
    attempted: number,
    succeeded: number,
    failed: number
  }>
}
```

**Rules:**
- Run providers concurrently with bounded concurrency and per-provider rate limits.
- Isolate provider failures; one failed provider must not fail the entire run.
- Apply timeouts, limited retries with backoff, and caching.
- Store raw response text before analysis. Keep a raw trace ID or response IDs.
- Only report citations supplied by the provider or discovered through a documented source-tracing step.
- Provider availability depends on actual API access and current provider terms. Treat Grok as optional and degrade gracefully.
- The agent's own reasoning model is not automatically a target provider. Include it in this tool only if a separate supported provider API call is intentionally configured.

### Tool 4 — `parse_ai_response`

**Purpose:** Extract structured evidence from one or more raw AI responses.

**Internal model:** Recommended optional LLM. A fast model can extract structured fields at scale. Inject the shared main model if appropriate, or use a dedicated internal model if a separate prompt/model is beneficial. Validate every result with Zod.

**Input:**
```ts
{
  startup_name: string,
  responses: Array<{
    response_id: string,
    provider: string,
    query_id: string,
    response_text: string,
    citations?: string[]
  }>
}
```

**Output:**
```ts
{
  parsed: Array<{
    response_id: string,
    provider: string,
    query_id: string,
    startup_mentioned: boolean,
    mention_count: number,
    first_mention_position: number | null,
    position_score: number | null,
    sentiment: "positive" | "neutral" | "negative" | "mixed" | "not_applicable",
    framing: string,
    claims: Array<{
      field: string,
      claim: string,
      polarity?: "supports" | "contradicts" | "neutral",
      evidence_quote?: string,
      confidence: number
    }>,
    citations: string[],
    parse_confidence: number
  }>,
  errors: Array<{ response_id: string, message: string }>
}
```

**Rules:**
- Distinguish no mention from parsing failure.
- `first_mention_position` must use a documented convention (e.g. paragraph index starting at 1); do not mix paragraph and list positions.
- `position_score` must follow a documented deterministic mapping based on first mention position.
- Evidence quotes must be literal excerpts from the source response.
- Do not treat an AI response as verified truth; it is evidence of what that AI system said.
- Use structured output where supported, and validate/retry malformed output only within a bounded retry limit.

### Tool 5 — `cross_reference_ground_truth`

**Purpose:** Compare claims extracted from AI responses with verified startup facts.

**Internal model:** Hybrid. Deterministic checks for exact fields such as founding year and pricing strings; optional LLM for semantic comparisons of product description and differentiators. Do not let the LLM silently overwrite ground truth.

**Input:**
```ts
{
  ground_truth: AIVisibilityInput["ground_truth"],
  parsed_claims: Array<{
    response_id: string,
    provider: string,
    field: string,
    claim: string,
    evidence_quote?: string,
    confidence: number
  }>
}
```

**Output:**
```ts
{
  comparisons: Array<{
    response_id: string,
    provider: string,
    field: string,
    ground_truth_value?: string,
    claimed_value: string,
    verdict: "matches" | "partial_match" | "contradicts" | "unknown",
    rationale: string,
    evidence_quote?: string,
    confidence: number
  }>,
  accuracy_score: number | null,
  flags: Array<{
    code: string,
    message: string,
    response_ids: string[]
  }>
}
```

**Rules:**
- Compare field by field.
- `unknown` means the ground truth does not contain enough information to decide.
- Penalize contradictions differently from omitted facts.
- Keep the supporting response excerpt for auditability.
- Do not use an LLM for arithmetic or final aggregation.

### Tool 6 — `detect_staleness`

**Purpose:** Detect old or potentially outdated claims, especially where current ground truth has changed.

**Internal model:** Usually no. Use timestamps and versioned facts. An optional LLM can classify ambiguous language such as “recently launched.”

**Input:**
```ts
{
  last_verified_at?: string,
  current_date: string,
  ground_truth: AIVisibilityInput["ground_truth"],
  parsed_claims: Array<{
    response_id: string,
    field: string,
    claim: string,
    evidence_quote?: string
  }>
}
```

**Output:**
```ts
{
  stale: boolean,
  age_days?: number,
  findings: Array<{
    response_id: string,
    field: string,
    claim: string,
    status: "current" | "possibly_stale" | "outdated" | "unknown",
    reason: string
  }>,
  flags: Array<{ code: string, severity: "info" | "warning" | "critical", message: string }>
}
```

**Rules:**
- Distinguish an old response from a demonstrably outdated claim.
- Do not infer the target model's exact training cutoff unless that information is available and reliable.
- Record run date and ground-truth version.

### Tool 7 — `trace_sources`

**Purpose:** Investigate cited URLs and likely public sources associated with claims or mentions.

**Internal model:** No required LLM. Use a search API such as SerpAPI and URL parsing; optional model-assisted claim/source matching may be added later.

**Input:**
```ts
{
  startup_name: string,
  competitors: string[],
  citations: Array<{
    response_id: string,
    provider: string,
    url: string,
    associated_claim?: string
  }>,
  max_results?: number
}
```

**Output:**
```ts
{
  sources: Array<{
    response_id?: string,
    url: string,
    title?: string,
    domain?: string,
    source_type: "official" | "review" | "news" | "directory" | "social" | "unknown",
    associated_claim?: string,
    found_in_search: boolean,
    confidence: number
  }>,
  errors: Array<{ query_or_url: string, message: string }>
}
```

**Rules:**
- Clearly distinguish URLs cited by the model from pages independently found through search.
- Do not claim a page caused an AI answer unless there is evidence for that causal link.
- Normalize and deduplicate URLs; enforce search caps and timeouts.

### Tool 8 — `audit_consistency`

**Purpose:** Compare startup facts across its own public surfaces, such as official website, pricing page, LinkedIn, G2, and press coverage.

**Internal model:** Optional. Fetch and normalize public pages first; use an LLM only for semantic comparison where deterministic matching is insufficient.

**Input:**
```ts
{
  startup_name: string,
  surfaces: Array<{
    surface_name: string,
    url: string,
    expected_fields?: string[]
  }>,
  ground_truth: AIVisibilityInput["ground_truth"]
}
```

**Output:**
```ts
{
  checked_surfaces: Array<{
    surface_name: string,
    url: string,
    status: "success" | "error" | "blocked" | "skipped",
    checked_at: string
  }>,
  issues: Array<{
    field: string,
    surfaces: string[],
    observed_values: Array<{ surface: string, value: string }>,
    expected_value?: string,
    severity: "low" | "medium" | "high",
    explanation: string
  }>,
  coverage: number
}
```

**Rules:**
- Respect website access controls, terms, and robots policies.
- Do not treat a blocked page as evidence of inconsistency.
- Record source URL and capture time for every observation.
- Surface names alone are not evidence; fetch and inspect actual accessible content.

### Tool 9 — `benchmark_competitors`

**Purpose:** Compare startup visibility with up to three named competitors using equivalent prompts.

**Internal model:** No separate LLM required. It composes the existing query execution and parsing capabilities. It may reuse the parser's internal model.

**Input:**
```ts
{
  startup_name: string,
  competitors: string[],
  query_templates: Array<{ query_id: string, template: string, query_type: string }>,
  providers: string[],
  max_competitors?: number
}
```

**Output:**
```ts
{
  competitors: Array<{
    competitor_name: string,
    queries_attempted: number,
    mention_rate_by_model: Record<string, number>,
    average_position_score: number | null,
    sentiment_score: number | null,
    evidence_response_ids: string[]
  }>,
  relative_visibility: Array<{
    competitor_name: string,
    startup_score: number | null,
    competitor_score: number | null,
    delta: number | null
  }>,
  status: "success" | "partial" | "skipped"
}
```

**Rules:**
- Tier 3 only unless product requirements explicitly change.
- Use equivalent query templates and providers for a fair comparison.
- Do not compare scores calculated from materially different query sets without a limitation flag.
- Limit to the top three configured competitors by default.

### Tool 10 — `calculate_visibility_score`

**Purpose:** Calculate normalized metrics and composite visibility score reproducibly.

**Internal model:** No.

**Input:**
```ts
{
  mention_rate: number | null,
  avg_position_score: number | null,
  accuracy_score: number | null,
  sentiment_score: number | null,
  competitive_fairness_score: number | null,
  tier: "1" | "2" | "3"
}
```

**Output:**
```ts
{
  component_scores: {
    mention_rate: number | null,
    avg_position_score: number | null,
    accuracy_score: number | null,
    sentiment_score: number | null,
    competitive_fairness_score: number | null
  },
  weights_used: Record<string, number>,
  composite_visibility_score: number | null,
  coverage: number,
  limitations: string[]
}
```

**Starting example weights** (product owner must approve and version these):
- Mention rate: 0.25
- Position: 0.20
- Accuracy: 0.25
- Sentiment: 0.15
- Competitive fairness: 0.15

**Rules:**
- These weights are a proposed starting point, not empirically validated facts.
- For Tier 1/2, competitive fairness may be unavailable. Do not silently assign it zero. Either calculate a clearly labeled renormalized score over available dimensions or return `null`; document the chosen policy.
- The same inputs and weight version must produce the same score.
- Clamp/validate inputs to `0..1`.
- Store the formula and version used with every run.

### Tool 11 — `persist_visibility_run`

**Purpose:** Save raw responses, parsed evidence, metrics, and final results for auditing and longitudinal tracking.

**Internal model:** No.

**Input:**
```ts
{
  run_id: string,
  startup_id: string,
  started_at: string,
  completed_at: string,
  input_snapshot: AIVisibilityInput,
  raw_response_ids: string[],
  parsed_result_ids: string[],
  output: AIVisibilityOutput,
  scoring_version: string
}
```

**Output:**
```ts
{
  persisted: boolean,
  run_id: string,
  record_id?: string,
  error?: string
}
```

**Rules:**
- Use the existing MongoDB/data-access layer.
- Keep DB connection management in application startup/config, not inside tools.
- Persist partial runs as partial when appropriate.
- Avoid duplicating large raw response payloads if they are stored in a separate collection; store references.
- Keep timestamps and input/ground-truth snapshots for longitudinal comparisons.

### Tool 12 — `compare_longitudinal_runs` (optional but recommended)

**Purpose:** Compare the latest run with previous runs for the same startup.

**Internal model:** No.

**Input:**
```ts
{
  startup_id: string,
  current_run_id: string,
  baseline_run_id?: string,
  lookback_runs?: number
}
```

**Output:**
```ts
{
  baseline_run_id?: string,
  current_run_id: string,
  metric_deltas: Record<string, number | null>,
  newly_appearing_flags: string[],
  resolved_flags: string[],
  summary_data: Array<{
    metric: string,
    previous_value: number | null,
    current_value: number | null,
    delta: number | null
  }>
}
```

**Rules:**
- Compare only compatible scoring versions and comparable provider/query coverage.
- Label comparisons that use different query batteries or ground-truth versions.
- Do not ask an LLM to calculate deltas.

## 6. LangChain tool and agent design

Use the `tool` function with Zod schemas for tool definitions, and use the agent API supported by the exact installed LangChain version. Check the project's installed package version and local `@LangchainDocs.md` before implementing; do not assume an API signature from another LangChain release.

Illustrative pattern (adjust imports/signatures to installed version):

```ts
const tools = [
  validateStartupInputTool,
  generateQueriesTool,
  executeAIQueriesTool,
  parseAIResponseTool,
  crossReferenceGroundTruthTool,
  detectStalenessTool,
  traceSourcesTool,
  auditConsistencyTool,
  benchmarkCompetitorsTool,
  calculateVisibilityScoreTool,
  persistVisibilityRunTool,
  compareLongitudinalRunsTool
];

const agent = createAgent({
  model: createGeminiModel(),
  tools,
  systemPrompt: AI_VISIBILITY_SYSTEM_PROMPT
});
```

Prefer tool factories for dependencies. Example:

```ts
const parseAIResponseTool = createParseAIResponseTool({
  model: optionalParserModel,
  // inject DB/search dependencies if needed
});
```

If a tool should use the main agent's exact model instance, construct the model once and inject it:

```ts
const mainModel = createGeminiModel();

const tools = [
  createGenerateQueriesTool({ model: mainModel }),
  createParseAIResponseTool({ model: mainModel }),
  calculateVisibilityScoreTool
];

const agent = createAgent({
  model: mainModel,
  tools,
  systemPrompt: AI_VISIBILITY_SYSTEM_PROMPT
});
```

This is an architectural illustration. Confirm the installed API's expected `systemPrompt`/prompt parameter and whether the model supports tool calling. If the shared model wrapper does not support tool binding or structured output, adapt the rotating provider layer before using it for the main agent.

## 7. Main system prompt requirements

The main agent's system prompt should instruct it to:
- act as the single orchestrator for startup AI visibility analysis;
- validate inputs before costly calls;
- follow the workflow and use tool outputs as evidence;
- execute only the requested tier's workload;
- never fabricate provider responses, citations, startup facts, or metrics;
- treat target-model answers as observations, not verified facts;
- call analysis tools on successful responses and preserve failures as partial results;
- use deterministic scoring output instead of calculating scores from intuition;
- run competitor benchmarking only for Tier 3;
- persist raw and derived artifacts before returning a final result;
- return the exact validated output contract;
- include limitations and partial coverage honestly;
- avoid endless tool loops and respect query, token, cost, concurrency, and timeout limits.

Important: do not rely on prompt text alone for security, cost, or correctness. Enforce tier limits, provider allowlists, and maximum query counts inside tool implementations.

## 8. Tier behavior

### Tier 1 — Teaser
- Small query subset.
- Public data only.
- Direct questions and a few category-discovery prompts.
- No competitor benchmarking.
- No longitudinal comparison required.
- Lower confidence due to smaller sample size.

### Tier 2 — Full audit
- Full configured query battery (suggested 40–80 queries, adjusted by budget).
- Full ground-truth comparison.
- Source tracing and consistency checks when available.
- No competitor benchmarking by default.
- Optionally save the first longitudinal snapshot.

### Tier 3 — Competitive and longitudinal
- Full startup query battery.
- Comparable query battery for up to three competitors.
- Competitive fairness metrics.
- Longitudinal deltas against prior compatible runs.
- Explicitly report any missing provider or competitor data.

## 9. Error handling, budgets, and observability

- A provider failure should mark affected result items failed and allow other providers to continue.
- A tool failure should return a typed, actionable error or partial result rather than inventing success.
- Set per-provider timeouts, rate limits, concurrency caps, and bounded retries.
- Cache responses by provider, query, relevant configuration, and time window when appropriate.
- Set a hard per-run budget for provider calls, search requests, tokens, and elapsed time.
- Log `run_id`, tool name, provider, duration, status, and retry count.
- Do not log secrets, private user data, or unredacted API keys.
- Store raw response text with access controls and retention policy.
- Capture provider/model names and versions when available.
- Include usage/cost metadata when provider APIs expose it.
- Treat returned web content and model responses as untrusted data, not instructions.

## 10. Suggested project structure

```text
src/
├── agents/
│   └── aiVisibility/
│       ├── agent.ts
│       ├── prompt.ts
│       ├── schemas.ts
│       └── tools/
│           ├── validateStartupInput.ts
│           ├── generateQueries.ts
│           ├── executeAIQueries.ts
│           ├── parseAIResponse.ts
│           ├── crossReferenceGroundTruth.ts
│           ├── detectStaleness.ts
│           ├── traceSources.ts
│           ├── auditConsistency.ts
│           ├── benchmarkCompetitors.ts
│           ├── calculateVisibilityScore.ts
│           ├── persistVisibilityRun.ts
│           └── compareLongitudinalRuns.ts
├── services/
│   ├── gemini.ts
│   ├── keyManager.ts
│   ├── providers/
│   │   ├── openai.ts
│   │   ├── anthropic.ts
│   │   ├── gemini.ts
│   │   ├── perplexity.ts
│   │   └── grok.ts
│   ├── search/
│   │   └── serpApi.ts
│   └── persistence/
│       └── visibilityRunRepository.ts
├── types/
│   └── schema.ts
├── config/
│   └── dbConn.ts
├── routes/
│   └── mainRoutes.ts
└── server.ts
```

Keep the existing repository conventions where they differ. Do not create empty provider modules until those providers are actually implemented.

## 11. Recommended implementation order

1. Confirm installed LangChain package versions and inspect `@LangchainDocs.md`.
2. Finalize input/output Zod schemas.
3. Implement the shared Gemini key manager/provider layer and test real per-request rotation.
4. Implement `validate_startup_input`.
5. Implement deterministic `generate_queries`.
6. Implement one provider end-to-end in `execute_ai_queries` (start with Gemini or another provider for which credentials are configured).
7. Persist raw responses and IDs.
8. Implement `parse_ai_response` with validated structured output.
9. Implement ground-truth comparison and staleness detection.
10. Implement deterministic scoring and unit tests.
11. Add source tracing and consistency audit.
12. Add Tier 3 competitor benchmarking and longitudinal comparison.
13. Assemble the single LangChain agent with a clear system prompt.
14. Test tool calling, partial failures, concurrency, and key rotation across main-agent and tool requests.
15. Add budget enforcement, caching, and observability before scaling toward hundreds of calls.

## 12. Acceptance criteria

- There is one top-level `AIVisibilityAgent`.
- Tools are independently testable and expose typed input/output contracts.
- Tools may use the main model, a specialized internal model, deterministic code, or external APIs.
- All Gemini calls routed through the shared rotating layer use one process-wide round-robin manager.
- Constructing a model does not consume a key; sending a Gemini request does.
- Provider failures do not erase successful results from other providers.
- Every extracted claim can be traced to a response and evidence excerpt where possible.
- Scores are deterministic, normalized, versioned, and testable.
- Tier limits and budget caps are enforced in code.
- Final output validates against `AIVisibilityOutputSchema`.
- A run can be audited and compared with a later run.

---

## 13. Decisions to confirm before production

1. Which AI providers are enabled and have valid API access?
2. Which exact LangChain JS version and agent API are installed?
3. Should the parser reuse the main model or use a dedicated fast model?
4. Which official weighting policy should apply when one or more metrics are unavailable?
5. Which public surfaces should consistency auditing check by default?
6. What are the per-tier caps for queries, provider calls, search calls, latency, and cost?
7. What data retention and privacy rules apply to raw AI responses?

Until these are confirmed, the proposed weights, query counts, provider list, and optional checks should be treated as configurable defaults rather than immutable requirements.
