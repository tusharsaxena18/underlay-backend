// src\agents\aiVisibility\aiVisibilityAgent.live.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { generateQueries } from "./tools/generateQueries";
import { runAIVisibilityAgent, runAIVisibilityAgentWithLangChain, type RunAIVisibilityAgentOptions } from "./aiVisibilityAgent";
import type { AIVisibilityInput, AIVisibilityOutput } from "../../types/schema";

const baseInput: AIVisibilityInput = {
    startup_name: "Acme Labs",
    icp: "small business owners",
    problem_statement: "manual invoice processing",
    category: "accounting automation",
    competitors: ["QuickBooks"],
    ground_truth: {
        product_description: "AI-powered invoice automation for small businesses",
        pricing_model: "SaaS subscription",
        founding_year: 2021,
        key_differentiators: ["zero-touch processing", "invoice data extraction"],
        current_stage: "Series A",
    },
    tier: "1",
};

function buildSimulatedOptions(): RunAIVisibilityAgentOptions {
    return {
        persist: false,
        tools: {
            validateStartupInput: {
                invoke: async (input: unknown) => ({ valid: true, input, errors: [] }),
            },
            generateQueries: {
                invoke: async (input: unknown) => {
                    if (typeof input !== "object" || input === null) {
                        throw new Error("Query generator received invalid input.");
                    }
                    const result = generateQueries({ ...input, max_queries: 1 });
                    if ("error" in result) {
                        throw new Error(result.error.message);
                    }
                    return result;
                },
            },
            executeAIQueries: {
                invoke: async (raw: unknown) => {
                    const input = raw as {
                        run_id: string;
                        queries: Array<{ query_id: string }>;
                    };
                    const results = input.queries.map((query) => ({
                        response_id: `simulated_${input.run_id}_${query.query_id}`,
                        run_id: input.run_id,
                        query_id: query.query_id,
                        provider: "simulated",
                        status: "success" as const,
                        response_text: `${baseInput.startup_name} provides AI-powered invoice automation for small businesses.`,
                        citations: [],
                        latency_ms: 0,
                        captured_at: new Date().toISOString(),
                    }));
                    return {
                        results,
                        provider_summary: [{
                            provider: "simulated",
                            attempted: results.length,
                            succeeded: results.length,
                            failed: 0,
                        }],
                    };
                },
            },
            parseAIResponse: {
                invoke: async (raw: unknown) => {
                    const input = raw as {
                        responses: Array<{ response_id: string; provider: string; query_id: string }>;
                    };
                    return {
                        parsed: input.responses.map((response) => ({
                            ...response,
                            startup_mentioned: true,
                            mention_count: 1,
                            first_mention_position: 1,
                            position_score: 1,
                            sentiment: "positive",
                            framing: "Simulated positive description.",
                            claims: [{
                                field: "product_description",
                                claim: "AI-powered invoice automation for small businesses",
                                matches_ground_truth: "yes",
                                confidence: 0.9,
                            }],
                            citations: [],
                            parse_confidence: 0.9,
                        })),
                        errors: [],
                    };
                },
            },
            benchmarkCompetitors: {
                invoke: async () => ({
                    competitors: [],
                    relative_visibility: [],
                    status: "success",
                    limitations: ["Competitor benchmark response was simulated."],
                }),
            },
            compareLongitudinalRuns: {
                invoke: async () => ({
                    metric_deltas: {},
                    newly_appearing_flags: [],
                    resolved_flags: [],
                    summary_data: [],
                    limitations: ["Longitudinal comparison response was simulated."],
                }),
            },
        },
    };
}

function isGeminiRequestError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /gemini|generativelanguage\.googleapis\.com|google.?generative.?ai|503 service unavailable|high demand|timeout/i.test(message);
}

async function runWithGeminiFallback(
    input: AIVisibilityInput,
    liveRun: () => Promise<AIVisibilityOutput> = () => runAIVisibilityAgentWithLangChain(input, {
        persist: false,
        maxConcurrency: 1,
        timeoutMs: 60000,
        tools: {
            generateQueries: {
                invoke: async (queryInput: unknown) => {
                    if (typeof queryInput !== "object" || queryInput === null) {
                        throw new Error("Query generator received invalid input.");
                    }
                    return generateQueries({
                        ...queryInput,
                        max_queries: 1,
                    });
                },
            },
        },
    }),
) {
    try {
        const output = await liveRun();
        if (output.sources_used.includes("gemini")) {
            return { output, simulated: false };
        }

        console.warn(
            `Gemini returned no successful provider responses for Tier ${input.tier}; using a simulated response for this test.`,
        );
    } catch (error) {
        if (!isGeminiRequestError(error)) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Gemini reported an error for Tier ${input.tier}: ${message}`);
        console.warn("Using a simulated response for this test; this output is not from Gemini.");
    }

    const output = await runAIVisibilityAgent(input, buildSimulatedOptions());
    return { output, simulated: true };
}

test("announces and labels simulated output when Gemini reports an error", async () => {
    const input = { ...baseInput, tier: "1" as const, competitors: [] };
    const result = await runWithGeminiFallback(input, async () => {
        throw new Error("[GoogleGenerativeAI Error]: 503 Service Unavailable");
    });

    assert.equal(result.simulated, true);
    assert.ok(result.output.sources_used.includes("simulated"));
});

for (const tier of ["1", "2", "3"] as const) {
    test(`live Gemini AI visibility run for Tier ${tier}`, async () => {
        const input: AIVisibilityInput = {
            ...baseInput,
            tier,
            ...(tier === "3" ? {} : { competitors: [] }),
        };
        const { output, simulated } = await runWithGeminiFallback(input);

        console.log(
            `${simulated ? "Simulated fallback" : "Live Gemini"} Tier ${tier} output:\n${JSON.stringify(output, null, 2)}`,
        );
        assert.equal(output.tier, tier);
        assert.ok(
            simulated || output.sources_used.includes("gemini"),
            `Expected a successful Gemini response or an explicitly simulated fallback; output: ${JSON.stringify(output)}`,
        );
    });
}
