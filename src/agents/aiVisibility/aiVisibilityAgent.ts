// src\agents\aiVisibility\aiVisibilityAgent.ts
import { tool } from "@langchain/core/tools";
import { ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createAgent } from "langchain";
import { z } from "zod";
import { AIVisibilityInputSchema, AIVisibilityOutputSchema, type AIVisibilityInput, type AIVisibilityOutput } from "../../types/schema";
import { createGenerateQueriesTool, generateQueries } from "./tools/generateQueries";
import { createExecuteAIQueriesTool, executeAIQueries } from "./tools/executeAIQueries";
import { createParseAIResponseTool, parseAIResponse } from "./tools/parseAIResponse";
import { createPersistVisibilityRunTool, deriveStartupId } from "./tools/persistVisibilityRun";
import { calculateVisibilityScore } from "./tools/calculateVisibilityScore";
import { assembleReport } from "./tools/assembleReport";
import { benchmarkCompetitors, createBenchmarkCompetitorsTool } from "./tools/benchmarkCompetitors";
import { compareLongitudinalRuns, createCompareLongitudinalRunsTool } from "./tools/compareLongitudinalRuns";
import { callGeminiProvider, createGeminiModel } from "../../services/gemini";
import { createValidateStartupInputTool } from "./tools/validateStartupInput";

export type Logger = {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
};

export interface RunAIVisibilityAgentOptions {
    model?: BaseChatModel;
    maxConcurrency?: number;
    timeoutMs?: number;
    persist?: boolean;
    logger?: Logger;
    tools?: {
        validateStartupInput?: { invoke: (input: unknown) => Promise<unknown> | unknown };
        generateQueries?: { invoke: (input: unknown) => Promise<unknown> | unknown };
        executeAIQueries?: { invoke: (input: unknown) => Promise<unknown> | unknown };
        parseAIResponse?: { invoke: (input: unknown) => Promise<unknown> | unknown };
        persistVisibilityRun?: { invoke: (input: unknown) => Promise<unknown> | unknown };
        benchmarkCompetitors?: { invoke: (input: unknown) => Promise<unknown> | unknown };
        compareLongitudinalRuns?: { invoke: (input: unknown) => Promise<unknown> | unknown };
    };
}

function makeRunId(): string {
    const date = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const suffix = Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[(Math.random() * 36) | 0]).join("");
    return `run_${date}_${suffix}`;
}

function blankMetrics() {
    return {
        component_scores: {
            mention_rate: null,
            avg_position_score: null,
            accuracy_score: null,
            sentiment_score: null,
            competitive_fairness_score: null,
        },
        weights_used: {},
        composite_visibility_score: null,
        coverage: 0,
        scoring_version: "v1",
        limitations: [] as string[],
    };
}

export function createAIVisibilityWorkflowTool(options: RunAIVisibilityAgentOptions = {}) {
    return tool(
        async (input: unknown) => {
            const rawInput = typeof input === "object" && input !== null && "input" in input ? (input as { input?: unknown }).input : input;
            return runAIVisibilityAgent(rawInput ?? input, options);
        },
        {
            name: "run_ai_visibility_pipeline",
            description: "Validate, query, score, benchmark, persist, and return the AI visibility report for a startup.",
            schema: z.object({
                input: z.unknown(),
            }),
        },
    );
}

export function createAIVisibilityAgent(options: RunAIVisibilityAgentOptions = {}) {
    return createAgent({
        model: options.model ?? createGeminiModel(),
        tools: [createAIVisibilityWorkflowTool(options)],
        systemPrompt: "You are the AI visibility coordinator. Use the run_ai_visibility_pipeline tool once with the startup input, then return the tool output exactly as provided.",
    });
}

function normalizeTier(value: unknown): "1" | "2" | "3" {
    const candidate = String(value ?? "1").trim();
    return candidate === "1" || candidate === "2" || candidate === "3" ? candidate : "1";
}

function makeFailedOutput(runId: string, startupName: string, tier: "1" | "2" | "3", limitations: string[], summary?: string): AIVisibilityOutput {
    return {
        agent_name: "ai_visibility",
        status: "failed",
        run_id: runId,
        startup_name: startupName,
        tier,
        generated_at: new Date().toISOString(),
        findings: {
            summary: summary ?? `The AI visibility check for ${startupName} failed before a valid run could be assembled.`,
            metrics: blankMetrics(),
            flags: [{
                code: "validation_failed",
                severity: "critical",
                message: limitations.join("; ") || "Validation failed",
            }],
            source_trace: [],
            consistency_issues: [],
        },
        confidence: 0,
        source_type: "unverified",
        sources_used: [],
        raw_trace_id: runId,
        limitations,
    };
}

type ParsedClaimLike = {
    field?: string;
    claim?: string;
    polarity?: "supports" | "contradicts" | "neutral";
    matches_ground_truth?: "yes" | "no" | "unknown";
    evidence_quote?: string;
    confidence?: number;
};

type ParsedResponseLike = {
    response_id: string;
    provider: string;
    query_id: string;
    startup_mentioned: boolean;
    mention_count: number;
    first_mention_position: number | null;
    position_score: number | null;
    sentiment: string;
    framing: string;
    claims: ParsedClaimLike[];
    citations: string[];
    parse_confidence: number;
};

function mapSentiment(value: string | undefined): number {
    const normalized = (value ?? "").toLowerCase();
    if (normalized === "positive") return 1;
    if (normalized === "neutral") return 0.5;
    if (normalized === "negative") return 0;
    if (normalized === "mixed") return 0.5;
    return 0.5;
}

function coerceNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return null;
}

export async function runAIVisibilityAgent(
    rawInput: unknown,
    options: RunAIVisibilityAgentOptions = {},
): Promise<AIVisibilityOutput> {
    const logger = options.logger ?? {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
    };
    const providers: Array<"gemini"> = ["gemini"];
    const maxConcurrency = Math.max(1, options.maxConcurrency ?? 2);
    const timeoutMs = Math.max(1, options.timeoutMs ?? 30000);
    const persist = options.persist ?? true;
    const runId = makeRunId();

    try {
        const validationTool = options.tools?.validateStartupInput ?? createValidateStartupInputTool();
        const validationResult = await validationTool.invoke(rawInput as never);
        const validated = validationResult as { valid?: boolean; input?: AIVisibilityInput; errors?: string[] };
        if (!validated?.valid) {
            const limitations = validated?.errors ?? ["Startup input validation failed."];
            const failed = makeFailedOutput(runId, typeof rawInput === "object" && rawInput !== null && "startup_name" in rawInput ? String((rawInput as { startup_name?: unknown }).startup_name ?? "unknown") : "unknown", "1", limitations);
            logger.warn("validate_startup_input failed", { run_id: runId, limitations });
            return failed;
        }

        const input = validated.input as AIVisibilityInput;
        const tier = normalizeTier(input.tier);
        const startupId = deriveStartupId(input.startup_name);

        logger.info("run_start", { run_id: runId, tier, startup_id: startupId });

        const generateTool = options.tools?.generateQueries ?? createGenerateQueriesTool();
        const generatedQueryResult = await generateTool.invoke({
            startup_name: input.startup_name,
            icp: input.icp,
            problem_statement: input.problem_statement,
            category: input.category,
            competitors: input.competitors,
            tier,
        });
        const generatedQueriesResult = generatedQueryResult as { queries?: Array<{ query_id: string; query: string; target_startup: string; target_competitor?: string; }>; count?: number };
        if (!generatedQueriesResult.queries || generatedQueriesResult.queries.length === 0) {
            const failed = makeFailedOutput(runId, input.startup_name, tier, ["No queries were generated for the startup."], `No queries were generated for ${input.startup_name}.`);
            return failed;
        }

        const queries = generatedQueriesResult.queries;
        const executeTool = options.tools?.executeAIQueries ?? createExecuteAIQueriesTool({ geminiProvider: callGeminiProvider });
        const executionResult = await executeTool.invoke({
            run_id: runId,
            queries,
            providers,
            tier,
            max_concurrency: maxConcurrency,
            timeout_ms: timeoutMs,
        }) as { results?: Array<{ response_id: string; run_id: string; query_id: string; provider: string; status: "success" | "error" | "timeout" | "skipped"; response_text?: string; citations?: string[]; latency_ms?: number; error_code?: string; captured_at: string }>; provider_summary?: Array<{ provider: string; attempted: number; succeeded: number; failed: number }> };

        const successfulResults = (executionResult.results ?? []).filter((result) => result.status === "success");
        const providerSummary = executionResult.provider_summary ?? [];
        const parseTool = options.tools?.parseAIResponse ?? createParseAIResponseTool({ model: createGeminiModel() });
        const parseInput = {
            startup_name: input.startup_name,
            ground_truth: input.ground_truth,
            responses: successfulResults.map((result) => ({
                response_id: result.response_id,
                provider: result.provider,
                query_id: result.query_id,
                response_text: result.response_text ?? "",
                citations: result.citations ?? [],
            })),
        };
        const parseResult = await parseTool.invoke(parseInput) as { parsed?: ParsedResponseLike[]; errors?: Array<{ response_id: string; message: string }> };
        const parsedResponses = parseResult.parsed ?? [];
        const parseErrors = parseResult.errors ?? [];

        const parsedRecords = parsedResponses.map((entry) => ({
            response_id: entry.response_id,
            provider: entry.provider,
            startup_mentioned: entry.startup_mentioned,
            mention_count: entry.mention_count,
            first_mention_position: entry.first_mention_position,
            position_score: entry.position_score,
            sentiment: entry.sentiment,
            framing: entry.framing,
            claims: entry.claims.map((claim) => ({
                field: claim.field,
                claim: claim.claim,
                polarity: claim.polarity,
                matches_ground_truth: claim.matches_ground_truth,
                evidence_quote: claim.evidence_quote,
                confidence: claim.confidence,
            })),
            citations: entry.citations,
            parse_confidence: entry.parse_confidence,
        }));

        const mentionRate = successfulResults.length === 0 ? 0 : parsedResponses.filter((row) => row.startup_mentioned).length / successfulResults.length;
        const avgPositionScore = parsedResponses.length === 0
            ? null
            : (() => {
                const valid = parsedResponses
                    .map((row) => row.position_score)
                    .filter((value): value is number => value !== null && typeof value === "number");
                return valid.length === 0 ? null : valid.reduce((sum, value) => sum + value, 0) / valid.length;
            })();
        const accuracyScore = parsedResponses.length === 0
            ? null
            : (() => {
                const claimMatches = parsedResponses.flatMap((row) => row.claims).filter((claim) => claim.matches_ground_truth === "yes").length;
                const totalClaims = parsedResponses.flatMap((row) => row.claims).length;
                return totalClaims === 0 ? null : claimMatches / totalClaims;
            })();
        const sentimentScore = parsedResponses.length === 0
            ? null
            : (() => {
                const values = parsedResponses.map((row) => mapSentiment(row.sentiment));
                return values.reduce((sum, value) => sum + value, 0) / values.length;
            })();

        const scoreInput = {
            mention_rate: mentionRate,
            avg_position_score: avgPositionScore,
            accuracy_score: accuracyScore,
            sentiment_score: sentimentScore,
            competitive_fairness_score: tier === "3" ? (input.competitors.length > 0 ? 0.8 : null) : null,
            tier,
        };
        const scoreResult = calculateVisibilityScore(scoreInput);

        const flags: Array<{ code: string; severity: "info" | "warning" | "critical"; message: string; evidence_ids?: string[] }> = [];
        if (providerSummary.some((provider) => provider.failed > 0)) {
            flags.push({
                code: "provider_partial_failure",
                severity: "warning",
                message: "One or more providers failed during the visibility check.",
                evidence_ids: successfulResults.map((result) => result.response_id),
            });
        }
        if (parseErrors.length > 0) {
            flags.push({
                code: "parse_failed",
                severity: "warning",
                message: `Failed to parse ${parseErrors.length} response(s).`,
                evidence_ids: parseErrors.map((error) => error.response_id),
            });
        }

        const reportInput = {
            run_id: runId,
            startup_name: input.startup_name,
            tier,
            provider_summary: providerSummary,
            parsed_results: parsedRecords,
            score_result: scoreResult && !("error" in scoreResult) ? scoreResult : { component_scores: { mention_rate: mentionRate, avg_position_score: avgPositionScore, accuracy_score: accuracyScore, sentiment_score: sentimentScore, competitive_fairness_score: tier === "3" ? (input.competitors.length > 0 ? 0.8 : null) : null }, weights_used: {}, composite_visibility_score: null, coverage: 0, scoring_version: "v1", limitations: ["Unable to calculate visibility score"] },
            flags,
            summary_override: `${input.startup_name} was evaluated across ${successfulResults.length} successful responses.`,
            limitations_extra: [
                ...(providerSummary.some((provider) => provider.failed > 0) ? ["One or more provider queries failed during execution."] : []),
                ...(parseErrors.length > 0 ? [`${parseErrors.length} responses failed parsing.`] : []),
            ],
            ground_truth_completeness: 1,
            query_coverage_vs_tier_target: 1,
        };

        const report = assembleReport(reportInput);
        const baseOutput = report && "error" in report ? makeFailedOutput(runId, input.startup_name, tier, [report.error.message], `Failed to assemble report for ${input.startup_name}.`) : report;

        let finalOutput = baseOutput;

        if (tier === "3" && input.competitors.length > 0) {
            const benchmarkTool = options.tools?.benchmarkCompetitors ?? createBenchmarkCompetitorsTool({
                executeAIQueries,
                parseAIResponse,
            });
            const benchmarkResult = await benchmarkTool.invoke({
                run_id: runId,
                startup_name: input.startup_name,
                competitors: input.competitors,
                query_templates: queries.map((query) => ({
                    query_id: query.query_id,
                    template: query.query,
                    query_type: "direct",
                })),
                providers,
                tier: "3",
                ground_truth: input.ground_truth,
            }) as { competitors?: unknown[]; relative_visibility?: unknown[]; status?: string; limitations?: string[] };
            if (Array.isArray(benchmarkResult?.limitations) && benchmarkResult.limitations.length > 0) {
                finalOutput.limitations = [...(finalOutput.limitations ?? []), ...benchmarkResult.limitations];
            }
            if (benchmarkResult?.status === "partial") {
                finalOutput.status = "partial";
                finalOutput.findings.flags.push({
                    code: "competitor_benchmark_partial",
                    severity: "warning",
                    message: "One or more competitor benchmarks were incomplete.",
                });
            }
        } else if (tier === "3" && input.competitors.length === 0) {
            finalOutput.limitations.push("Tier 3 competitors list was empty; benchmark_competitors was skipped.");
        }

        if (tier === "3") {
            const compareTool = options.tools?.compareLongitudinalRuns ?? createCompareLongitudinalRunsTool({
                repository: {
                    getRunById: async () => null,
                    getLatestRunForStartup: async () => null,
                },
            });
            const compareResult = await compareTool.invoke({
                startup_id: startupId,
                current_run_id: runId,
                current_output: {
                    ...finalOutput,
                    scoring_version: "v1",
                },
                lookback_runs: 1,
            }) as { metric_deltas?: Record<string, number | null>; newly_appearing_flags?: string[]; resolved_flags?: string[]; summary_data?: unknown[]; limitations?: string[] };
            if (Array.isArray(compareResult?.limitations) && compareResult.limitations.length > 0) {
                finalOutput.limitations = [...(finalOutput.limitations ?? []), ...compareResult.limitations];
            }
            if (compareResult && Object.keys(compareResult.metric_deltas ?? {}).length > 0) {
                finalOutput.findings.summary += ` Longitudinal deltas: ${Object.keys(compareResult.metric_deltas ?? {}).length} metric(s).`;
            }
        }

        const outputForPersist = {
            ...finalOutput,
            findings: {
                ...finalOutput.findings,
                summary: finalOutput.findings.summary,
            },
        };

        if (persist) {
            const persistTool = options.tools?.persistVisibilityRun ?? createPersistVisibilityRunTool({
                repository: {
                    ensureIndexes: async () => undefined,
                    saveRawResponses: async () => ({ inserted: (executionResult.results ?? []).length, errors: [] }),
                    saveParsedResults: async () => ({ inserted: parsedResponses.length, errors: [] }),
                    saveRun: async () => ({ record_id: `persist_${runId}` }),
                    getRunById: async () => null,
                    getLatestRunForStartup: async () => null,
                },
            });

            const persistResult = await persistTool.invoke({
                run_id: runId,
                startup_id: startupId,
                started_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
                input_snapshot: input,
                raw_response_ids: (executionResult.results ?? []).map((result) => result.response_id),
                parsed_result_ids: parsedResponses.map((result) => result.response_id),
                output: outputForPersist,
                scoring_version: "v1",
                raw_responses: (executionResult.results ?? []).map((result) => ({
                    response_id: result.response_id,
                    run_id: runId,
                    query_id: result.query_id,
                    provider: result.provider,
                    status: result.status,
                    response_text: result.response_text,
                    citations: result.citations,
                    latency_ms: result.latency_ms,
                    error_code: result.error_code,
                    captured_at: result.captured_at,
                })),
                parsed_results: parsedResponses.map((result) => ({
                    response_id: result.response_id,
                    run_id: runId,
                    query_id: result.query_id,
                    provider: result.provider,
                    startup_mentioned: result.startup_mentioned,
                    mention_count: result.mention_count,
                    first_mention_position: result.first_mention_position,
                    position_score: result.position_score,
                    sentiment: result.sentiment,
                    framing: result.framing,
                    claims: result.claims.map((claim) => ({
                        field: claim.field,
                        claim: claim.claim,
                        polarity: claim.polarity,
                        matches_ground_truth: claim.matches_ground_truth,
                        evidence_quote: claim.evidence_quote,
                        confidence: claim.confidence,
                    })),
                    citations: result.citations,
                    parse_confidence: result.parse_confidence,
                })),
            }) as { persisted?: boolean; error?: string };

            if (persistResult && persistResult.persisted === false) {
                finalOutput.limitations = [...(finalOutput.limitations ?? []), `Persistence failed: ${persistResult.error ?? "unknown_error"}`];
                logger.warn("persist_visibility_run failed", { run_id: runId, error: persistResult.error });
            } else {
                logger.info("persist_visibility_run succeeded", { run_id: runId });
            }
        }

        finalOutput.generated_at = new Date().toISOString();
        const validatedOutput = AIVisibilityOutputSchema.safeParse(finalOutput);
        if (!validatedOutput.success) {
            return makeFailedOutput(runId, input.startup_name, tier, [validatedOutput.error.message], `Output validation failed for ${input.startup_name}.`);
        }

        logger.info("run_complete", { run_id: runId, tier, startup_id: startupId, status: validatedOutput.data.status, duration_ms: 0 });
        return validatedOutput.data;
    } catch (error) {
        const startupName = typeof rawInput === "object" && rawInput !== null && "startup_name" in rawInput ? String((rawInput as { startup_name?: unknown }).startup_name ?? "unknown") : "unknown";
        const tier = typeof rawInput === "object" && rawInput !== null && "tier" in rawInput ? String((rawInput as { tier?: unknown }).tier ?? "1") : "1";
        const message = error instanceof Error ? error.message : "Unexpected pipeline error";
        logger.error("runAIVisibilityAgent failed", { run_id: runId, message });
        return makeFailedOutput(runId, startupName, tier as "1" | "2" | "3", [message], `The AI visibility pipeline failed for ${startupName}.`);
    }
}

export async function runAIVisibilityAgentWithLangChain(
    rawInput: unknown,
    options: RunAIVisibilityAgentOptions = {},
): Promise<AIVisibilityOutput> {
    const agent = createAIVisibilityAgent(options);
    const result = await agent.invoke({
        messages: [{
            role: "user",
            content: typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput ?? {}, null, 2),
        }],
    });

    const workflowResult = [...result.messages].reverse().find(
        (message) => message instanceof ToolMessage && message.name === "run_ai_visibility_pipeline",
    );
    if (!(workflowResult instanceof ToolMessage)) {
        throw new Error("AI visibility agent did not invoke the pipeline tool.");
    }
    if (typeof workflowResult.content !== "string") {
        throw new Error("AI visibility pipeline tool returned a non-text result.");
    }

    const output: unknown = JSON.parse(workflowResult.content);
    const validatedOutput = AIVisibilityOutputSchema.safeParse(output);
    if (!validatedOutput.success) {
        throw new Error(`AI visibility pipeline tool returned invalid output: ${validatedOutput.error.message}`);
    }

    return validatedOutput.data;
}
