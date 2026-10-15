// src\agents\aiVisibility\aiVisibilityAgent.test.ts
//
// Integration-style tests for the AIVisibility agent pipeline.
// All external I/O (LLM calls, DB writes) is replaced with stub tools so the
// tests are deterministic and run without network access.
//
// Each test exercises runAIVisibilityAgent with a realistic input and verifies
// the structural shape of the output — not individual tool internals.

import assert from "node:assert/strict";
import test from "node:test";
import { AIMessageChunk } from "@langchain/core/messages";
import type { BaseChatModelCallOptions, BindToolsInput } from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import { RunnableLambda, type Runnable } from "@langchain/core/runnables";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { runAIVisibilityAgent, runAIVisibilityAgentWithLangChain, type RunAIVisibilityAgentOptions } from "./aiVisibilityAgent";
import { AIVisibilityOutputSchema, type AIVisibilityInput } from "../../types/schema";

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const baseInput: AIVisibilityInput = {
    startup_name: "Acme Labs",
    icp: "small business owners",
    problem_statement: "manual invoice processing",
    category: "accounting automation",
    competitors: ["Beta Corp", "Gamma Inc"],
    ground_truth: {
        product_description: "AI-powered invoice automation for SMBs",
        pricing_model: "SaaS subscription",
        founding_year: 2021,
        key_differentiators: ["zero-touch processing", "99.5% accuracy"],
        current_stage: "Series A",
    },
    tier: "1",
};

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

/** Returns a validation stub that always marks input as valid and echoes the received input. */
function stubValidateTool(override?: Partial<AIVisibilityInput>) {
    return {
        invoke: async (raw: unknown) => {
            // Merge override on top of the raw input so callers can patch specific fields
            const merged = { ...(raw as object), ...(override ?? {}) } as AIVisibilityInput;
            return {
                valid: true,
                input: merged,
                errors: [],
            };
        },
    };
}

/** Returns a query-generation stub that emits a small fixed query set. */
function stubGenerateTool(queryCount = 3) {
    return {
        invoke: async () => ({
            queries: Array.from({ length: queryCount }, (_, i) => ({
                query_id: `q_direct_${i + 1}`,
                query: `What does Acme Labs do? (variant ${i + 1})`,
                query_type: "direct",
                target_startup: "Acme Labs",
            })),
            count: queryCount,
        }),
    };
}

/** Returns an execution stub that wraps each query as a successful Gemini response. */
function stubExecuteTool(queries: number) {
    return {
        invoke: async (input: unknown) => {
            const { run_id } = input as { run_id: string };
            const results = Array.from({ length: queries }, (_, i) => ({
                response_id: `resp_${run_id}_gemini_q_direct_${i + 1}`,
                run_id,
                query_id: `q_direct_${i + 1}`,
                provider: "gemini",
                status: "success" as const,
                response_text: `Acme Labs is an AI startup. It was founded in 2021.`,
                citations: [],
                latency_ms: 120,
                captured_at: new Date().toISOString(),
            }));
            return {
                results,
                provider_summary: [{ provider: "gemini", attempted: queries, succeeded: queries, failed: 0 }],
            };
        },
    };
}

/** Returns a parser stub that marks every response as a Acme Labs mention with positive sentiment. */
function stubParseTool(queries: number) {
    return {
        invoke: async (input: unknown) => {
            const { responses } = input as { responses: Array<{ response_id: string; provider: string; query_id: string }> };
            const parsed = responses.map((r) => ({
                response_id: r.response_id,
                provider: r.provider,
                query_id: r.query_id,
                startup_mentioned: true,
                mention_count: 2,
                first_mention_position: 1,
                position_score: 1,
                sentiment: "positive",
                framing: "positive description",
                claims: [
                    {
                        field: "founding_year",
                        claim: "founded in 2021",
                        matches_ground_truth: "yes" as const,
                        confidence: 0.9,
                    },
                ],
                citations: [],
                parse_confidence: 0.95,
            }));
            return { parsed, errors: [] };
        },
    };
}

/** Returns a persist-run stub that always succeeds without touching MongoDB. */
function stubPersistTool() {
    return {
        invoke: async (input: unknown) => {
            const { run_id } = input as { run_id: string };
            return { persisted: true, run_id, record_id: `persist_${run_id}` };
        },
    };
}

/** Returns a benchmark-competitors stub (Tier 3). */
function stubBenchmarkTool() {
    return {
        invoke: async () => ({
            competitors: [],
            relative_visibility: [],
            competitive_fairness_score: 0.75,
            status: "success" as const,
            limitations: [],
        }),
    };
}

/** Returns a longitudinal-comparison stub (Tier 3). */
function stubCompareTool() {
    return {
        invoke: async () => ({
            baseline_run_id: undefined,
            current_run_id: "current",
            metric_deltas: {},
            newly_appearing_flags: [],
            resolved_flags: [],
            summary_data: [],
            limitations: [],
        }),
    };
}

// Compose all stubs into a RunAIVisibilityAgentOptions object
function buildStubOptions(queryCount = 3): RunAIVisibilityAgentOptions {
    const options: RunAIVisibilityAgentOptions = {
        persist: true,
        tools: {
            validateStartupInput: stubValidateTool(),
            generateQueries: stubGenerateTool(queryCount),
            executeAIQueries: stubExecuteTool(queryCount),
            parseAIResponse: stubParseTool(queryCount),
            persistVisibilityRun: stubPersistTool(),
            benchmarkCompetitors: stubBenchmarkTool(),
            compareLongitudinalRuns: stubCompareTool(),
        },
    };
    return options;
}

class ScriptedToolCallingModel extends BaseChatModel {
    invocationCount = 0;

    constructor(private readonly pipelineInput: AIVisibilityInput) {
        super({});
    }

    _llmType(): string {
        return "scripted-tool-calling-test-model";
    }

    async _generate(): Promise<never> {
        throw new Error("The agent should invoke the model through bindTools.");
    }

    bindTools(
        _tools: BindToolsInput[],
        _kwargs?: Partial<BaseChatModelCallOptions>,
    ): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions> {
        return RunnableLambda.from(async () => {
            this.invocationCount += 1;
            if (this.invocationCount === 1) {
                return new AIMessageChunk({
                    content: "",
                    tool_call_chunks: [{
                        name: "run_ai_visibility_pipeline",
                        args: JSON.stringify({ input: this.pipelineInput }),
                        id: "call_pipeline",
                        index: 0,
                    }],
                });
            }
            return new AIMessageChunk({ content: "Pipeline completed." });
        });
    }
}

function buildLangChainAgentOptions(input: AIVisibilityInput, queryCount: number): RunAIVisibilityAgentOptions {
    return {
        ...buildStubOptions(queryCount),
        persist: false,
        model: new ScriptedToolCallingModel(input),
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("LangChain agent invokes the pipeline tool and returns its validated output", async () => {
    let benchmarkCalled = false;
    let compareCalled = false;
    const input = { ...baseInput, tier: "3" as const };
    const options = buildStubOptions(5);
    options.persist = false;
    const model = new ScriptedToolCallingModel(input);
    options.model = model;
    options.tools = {
        ...options.tools,
        benchmarkCompetitors: {
            invoke: async () => {
                benchmarkCalled = true;
                return { competitors: [], relative_visibility: [], status: "success" as const, limitations: [] };
            },
        },
        compareLongitudinalRuns: {
            invoke: async () => {
                compareCalled = true;
                return { metric_deltas: {}, newly_appearing_flags: [], resolved_flags: [], summary_data: [], limitations: [] };
            },
        },
    };

    const output = await runAIVisibilityAgentWithLangChain(input, options);

    assert.equal(model.invocationCount, 2, "the model should run once to call the tool and once after its result");
    assert.equal(output.tier, "3");
    assert.equal(benchmarkCalled, true);
    assert.equal(compareCalled, true);
    assert.ok(AIVisibilityOutputSchema.safeParse(output).success);
});

test("agent returns a valid AIVisibilityOutput for a Tier 1 run", async () => {
    const input = { ...baseInput, tier: "1" as const };
    const output = await runAIVisibilityAgentWithLangChain(input, buildLangChainAgentOptions(input, 3));

    // Top-level contract
    assert.equal(output.agent_name, "ai_visibility");
    assert.equal(output.startup_name, "Acme Labs");
    assert.equal(output.tier, "1");
    assert.ok(["success", "partial", "failed"].includes(output.status));
    assert.ok(typeof output.run_id === "string" && output.run_id.length > 0);
    assert.ok(typeof output.generated_at === "string");

    // Zod validation passes
    const parsed = AIVisibilityOutputSchema.safeParse(output);
    assert.ok(parsed.success, `Output did not match AIVisibilityOutputSchema: ${!parsed.success && parsed.error?.message}`);
});

test("confidence reflects available ground truth and emitted queries", async () => {
    const output = await runAIVisibilityAgent({ ...baseInput, tier: "1" }, buildStubOptions(2));
    const expectedConfidence = 0.4 + 0.3 + 0.2 * (5 / 7) + 0.1 * (2 / 3);

    assert.equal(output.confidence, expectedConfidence);
    assert.equal(output.scoring_details.coverage, 1);
});

test("agent returns a valid AIVisibilityOutput for a Tier 2 run", async () => {
    const input = { ...baseInput, tier: "2" as const };
    const output = await runAIVisibilityAgentWithLangChain(input, buildLangChainAgentOptions(input, 5));

    assert.equal(output.tier, "2");
    assert.ok(["success", "partial"].includes(output.status),
        `Expected success or partial for Tier 2, got: ${output.status}`);

    const parsed = AIVisibilityOutputSchema.safeParse(output);
    assert.ok(parsed.success, `Tier 2 output validation failed: ${!parsed.success && parsed.error?.message}`);
});

test("agent returns a valid AIVisibilityOutput for a Tier 3 run with competitors", async () => {
    const input = { ...baseInput, tier: "3" as const };
    const output = await runAIVisibilityAgentWithLangChain(input, buildLangChainAgentOptions(input, 5));

    assert.equal(output.tier, "3");
    assert.ok(["success", "partial"].includes(output.status),
        `Expected success or partial for Tier 3, got: ${output.status}`);
    assert.equal(output.scoring_details?.component_scores.competitive_fairness_score, 0.75);

    const parsed = AIVisibilityOutputSchema.safeParse(output);
    assert.ok(parsed.success, `Tier 3 output validation failed: ${!parsed.success && parsed.error?.message}`);
});

test("agent returns a failed output when validation fails", async () => {
    const badInput = {
        // startup_name is deliberately missing
        icp: "small businesses",
        problem_statement: "invoice processing",
        category: "accounting",
        competitors: [],
        ground_truth: {
            product_description: "desc",
            pricing_model: "free",
            founding_year: 2020,
            key_differentiators: [],
            current_stage: "seed",
        },
        tier: "1",
    };

    const options: RunAIVisibilityAgentOptions = {
        persist: false,
        tools: {
            generateQueries: stubGenerateTool(),
            executeAIQueries: stubExecuteTool(3),
            parseAIResponse: stubParseTool(3),
            persistVisibilityRun: stubPersistTool(),
        },
    };

    const output = await runAIVisibilityAgent(badInput, options);
    assert.equal(output.status, "failed");
    assert.ok(output.limitations.length > 0, "Failed run should include at least one limitation");
});

test("agent handles provider execution failure gracefully and returns partial status", async () => {
    const failingExecuteTool = {
        invoke: async (input: unknown) => {
            const { run_id } = input as { run_id: string };
            return {
                results: [
                    {
                        response_id: `resp_${run_id}_gemini_q_direct_1`,
                        run_id,
                        query_id: "q_direct_1",
                        provider: "gemini",
                        status: "error" as const,
                        error_code: "provider_failed",
                        captured_at: new Date().toISOString(),
                    },
                ],
                provider_summary: [{ provider: "gemini", attempted: 1, succeeded: 0, failed: 1 }],
            };
        },
    };

    const options: RunAIVisibilityAgentOptions = {
        persist: false,
        tools: {
            validateStartupInput: stubValidateTool(),
            generateQueries: stubGenerateTool(1),
            executeAIQueries: failingExecuteTool,
            parseAIResponse: stubParseTool(0),
            persistVisibilityRun: stubPersistTool(),
        },
    };

    const output = await runAIVisibilityAgent({ ...baseInput, tier: "1" }, options);
    // With zero successful responses, report should still be structured
    assert.ok(["partial", "failed"].includes(output.status),
        `Expected partial or failed when provider fails, got: ${output.status}`);

    const parsed = AIVisibilityOutputSchema.safeParse(output);
    assert.ok(parsed.success, `Output should still be schema-valid even on provider failure: ${!parsed.success && parsed.error?.message}`);
});

test("agent does not run benchmark or longitudinal tools for Tier 1 and 2", async () => {
    let benchmarkCalled = false;
    let compareCalled = false;

    const trackingBenchmark = {
        invoke: async () => { benchmarkCalled = true; return { competitors: [], relative_visibility: [], status: "success" as const }; },
    };
    const trackingCompare = {
        invoke: async () => { compareCalled = true; return { metric_deltas: {}, newly_appearing_flags: [], resolved_flags: [], summary_data: [], limitations: [] }; },
    };

    const options: RunAIVisibilityAgentOptions = {
        persist: false,
        tools: {
            validateStartupInput: stubValidateTool(),
            generateQueries: stubGenerateTool(3),
            executeAIQueries: stubExecuteTool(3),
            parseAIResponse: stubParseTool(3),
            persistVisibilityRun: stubPersistTool(),
            benchmarkCompetitors: trackingBenchmark,
            compareLongitudinalRuns: trackingCompare,
        },
    };

    await runAIVisibilityAgent({ ...baseInput, tier: "1" }, options);
    assert.equal(benchmarkCalled, false, "benchmark_competitors must not run for Tier 1");
    assert.equal(compareCalled, false, "compare_longitudinal_runs must not run for Tier 1");

    benchmarkCalled = false;
    compareCalled = false;

    await runAIVisibilityAgent({ ...baseInput, tier: "2" }, options);
    assert.equal(benchmarkCalled, false, "benchmark_competitors must not run for Tier 2");
    assert.equal(compareCalled, false, "compare_longitudinal_runs must not run for Tier 2");
});

test("agent runs benchmark and longitudinal comparison tools for Tier 3", async () => {
    let benchmarkCalled = false;
    let compareCalled = false;

    const trackingBenchmark = {
        invoke: async () => {
            benchmarkCalled = true;
            return { competitors: [], relative_visibility: [], status: "success" as const, limitations: [] };
        },
    };
    const trackingCompare = {
        invoke: async () => {
            compareCalled = true;
            return { metric_deltas: {}, newly_appearing_flags: [], resolved_flags: [], summary_data: [], limitations: [] };
        },
    };

    const options: RunAIVisibilityAgentOptions = {
        persist: false,
        tools: {
            validateStartupInput: stubValidateTool(),
            generateQueries: stubGenerateTool(5),
            executeAIQueries: stubExecuteTool(5),
            parseAIResponse: stubParseTool(5),
            persistVisibilityRun: stubPersistTool(),
            benchmarkCompetitors: trackingBenchmark,
            compareLongitudinalRuns: trackingCompare,
        },
    };

    await runAIVisibilityAgent({ ...baseInput, tier: "3" }, options);
    assert.equal(benchmarkCalled, true, "benchmark_competitors must run for Tier 3 when competitors present");
    assert.equal(compareCalled, true, "compare_longitudinal_runs must run for Tier 3");
});

test("agent output always contains a non-empty run_id and valid ISO generated_at", async () => {
    const output = await runAIVisibilityAgent({ ...baseInput, tier: "1" }, buildStubOptions(3));

    assert.ok(output.run_id.startsWith("run_"), `run_id should start with 'run_', got: ${output.run_id}`);
    assert.ok(!Number.isNaN(Date.parse(output.generated_at)), `generated_at must be a valid ISO datetime`);
});

test("agent skips benchmark when Tier 3 has no competitors", async () => {
    let benchmarkCalled = false;

    const options: RunAIVisibilityAgentOptions = {
        persist: false,
        tools: {
            validateStartupInput: stubValidateTool({ competitors: [] }),
            generateQueries: stubGenerateTool(5),
            executeAIQueries: stubExecuteTool(5),
            parseAIResponse: stubParseTool(5),
            persistVisibilityRun: stubPersistTool(),
            benchmarkCompetitors: {
                invoke: async () => {
                    benchmarkCalled = true;
                    return { competitors: [], relative_visibility: [], status: "success" as const };
                },
            },
            compareLongitudinalRuns: stubCompareTool(),
        },
    };

    const output = await runAIVisibilityAgent({ ...baseInput, competitors: [], tier: "3" }, options);
    assert.equal(benchmarkCalled, false, "benchmark must not be called with an empty competitor list");
    assert.ok(output.limitations.some((l) => l.includes("benchmark")),
        "Limitations should mention that benchmark was skipped");
});
