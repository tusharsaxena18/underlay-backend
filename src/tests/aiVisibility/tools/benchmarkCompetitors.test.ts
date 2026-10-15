// src\tests\aiVisibility\tools\benchmarkCompetitors.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseAIResponseInputSchema } from "../../../agents/aiVisibility/tools/parseAIResponse";
import { benchmarkCompetitors } from "../../../agents/aiVisibility/tools/benchmarkCompetitors";
import { executeAIQueriesInputSchema } from "../../../agents/aiVisibility/tools/executeAIQueries";

const benchmarkInput = {
    run_id: "run_1",
    startup_name: "Acme",
    competitors: ["Beta"],
    query_templates: [{
        query_id: "q_1",
        template: "Compare {startup_name} and {competitor}",
        query_type: "competitive",
    }],
    providers: ["gemini"] as const,
    tier: "3",
    ground_truth: {
        product_description: "Invoice automation",
        pricing_model: "subscription",
        key_differentiators: ["automated reconciliation"],
        current_stage: "seed",
    },
};

function benchmarkDeps(competitorMentioned: boolean) {
    return {
        executeAIQueries: async (input: unknown) => {
            const parsedInput = executeAIQueriesInputSchema.parse(input);
            return {
                results: parsedInput.queries.map((query) => ({
                    response_id: `response_${query.query_id}_${query.target_competitor ?? "startup"}`,
                    run_id: parsedInput.run_id,
                    query_id: query.query_id,
                    provider: "gemini",
                    status: "success" as const,
                    response_text: "A product comparison.",
                    citations: [],
                    captured_at: new Date().toISOString(),
                })),
                provider_summary: [{
                    provider: "gemini",
                    attempted: parsedInput.queries.length,
                    succeeded: parsedInput.queries.length,
                    failed: 0,
                }],
            };
        },
        parseAIResponse: async (input: unknown) => {
            const parsedInput = parseAIResponseInputSchema.parse(input);
            return {
                parsed: parsedInput.responses.map((response) => ({
                    response_id: response.response_id,
                    provider: response.provider,
                    query_id: response.query_id,
                    startup_mentioned: parsedInput.startup_name === "Acme"
                        ? true
                        : competitorMentioned,
                    mention_count: 1,
                    first_mention_position: 1,
                    position_score: 1,
                    sentiment: "neutral" as const,
                    framing: "A neutral comparison.",
                    claims: [],
                    citations: [],
                    parse_confidence: 1,
                })),
                errors: [],
            };
        },
    };
}

test("competitive fairness score is derived from comparable parsed visibility rates", async () => {
    const result = await benchmarkCompetitors(benchmarkInput, benchmarkDeps(false));

    assert.equal(result.status, "success");
    assert.equal(result.relative_visibility[0]?.startup_score, 1);
    assert.equal(result.relative_visibility[0]?.competitor_score, 0);
    assert.equal(result.competitive_fairness_score, 0);
});

test("competitive fairness score is unavailable when either side has no parsed evidence", async () => {
    const deps = benchmarkDeps(false);
    deps.parseAIResponse = async (input: unknown) => {
        const parsedInput = parseAIResponseInputSchema.parse(input);
        return {
            parsed: parsedInput.startup_name === "Acme"
                ? parsedInput.responses.map((response) => ({
                    response_id: response.response_id,
                    provider: response.provider,
                    query_id: response.query_id,
                    startup_mentioned: true,
                    mention_count: 1,
                    first_mention_position: 1,
                    position_score: 1,
                    sentiment: "neutral" as const,
                    framing: "A neutral comparison.",
                    claims: [],
                    citations: [],
                    parse_confidence: 1,
                }))
                : [],
            errors: [],
        };
    };

    const result = await benchmarkCompetitors(benchmarkInput, deps);
    assert.equal(result.competitive_fairness_score, null);
    assert.equal(result.status, "partial");
    assert.ok(result.limitations?.some((limitation) => limitation.includes("no competitor responses parsed")));
});
