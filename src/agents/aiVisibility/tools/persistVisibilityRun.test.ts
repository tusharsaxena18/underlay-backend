// src\agents\aiVisibility\tools\persistVisibilityRun.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import { AIVisibilityInputSchema, AIVisibilityOutputSchema } from "../../../types/schema";
import {
    createPersistVisibilityRunTool,
    deriveStartupId,
    persistVisibilityRun,
    persistVisibilityRunInputSchema,
} from "./persistVisibilityRun";

function makeValidInput(overrides: Partial<Record<string, unknown>> = {}) {
    const base = {
        run_id: "run_123",
        startup_id: "acme_corp",
        started_at: new Date("2025-01-01T00:00:00.000Z").toISOString(),
        completed_at: new Date("2025-01-01T00:00:05.000Z").toISOString(),
        input_snapshot: {
            startup_name: "Acme Corp",
            icp: "SaaS teams",
            problem_statement: "manual reporting",
            category: "analytics",
            competitors: ["Competitor A"],
            ground_truth: {
                product_description: "A reporting platform",
                pricing_model: "usage-based",
                founding_year: 2022,
                key_differentiators: ["automation"],
                current_stage: "series_a",
            },
            tier: 2,
        },
        raw_response_ids: ["raw_1"],
        parsed_result_ids: ["parsed_1"],
        output: {
            agent_name: "ai_visibility",
            status: "success",
            run_id: "run_123",
            startup_name: "Acme Corp",
            tier: "2",
            generated_at: new Date("2025-01-01T00:00:06.000Z").toISOString(),
            findings: {
                summary: "Acme Corp was surfaced in a positive response.",
                metrics: {
                    mention_rate_by_model: { gemini: 1 },
                    avg_position_score: 0.85,
                    accuracy_score: 1,
                    sentiment_score: 1,
                    competitive_fairness_score: 0.8,
                    composite_visibility_score: 0.9,
                },
                flags: [],
                source_trace: [],
                consistency_issues: [],
            },
            scoring_details: {
                component_scores: {
                    mention_rate: 1,
                    avg_position_score: 0.85,
                    accuracy_score: 1,
                    sentiment_score: 1,
                    competitive_fairness_score: 0.8,
                },
                weights_used: {
                    mention_rate: 0.3,
                    avg_position_score: 0.2,
                    accuracy_score: 0.2,
                    sentiment_score: 0.2,
                    competitive_fairness_score: 0.1,
                },
                coverage: 1,
                scoring_version: "v1",
                limitations: [],
            },
            confidence: 0.9,
            source_type: "verified",
            sources_used: ["google"],
            raw_trace_id: "run_123",
            limitations: [],
        },
        scoring_version: "v1",
        raw_responses: [{
            response_id: "raw_1",
            run_id: "run_123",
            query_id: "q_1",
            provider: "google",
            status: "success",
            response_text: "Acme Corp helps teams automate reporting.",
            citations: ["https://example.com/citation"],
            captured_at: new Date("2025-01-01T00:00:04.000Z").toISOString(),
        }],
        parsed_results: [{
            response_id: "raw_1",
            run_id: "run_123",
            query_id: "q_1",
            provider: "google",
            startup_mentioned: true,
            mention_count: 1,
            first_mention_position: 1,
            position_score: 1,
            sentiment: "positive",
            framing: "Acme Corp is a useful analytics platform.",
            claims: [{
                field: "product_description",
                claim: "Acme Corp automates reporting.",
                polarity: "supports",
                matches_ground_truth: "yes",
                evidence_quote: "Acme Corp helps teams automate reporting.",
                confidence: 0.9,
            }],
            citations: ["https://example.com/citation"],
            parse_confidence: 1,
        }],
    } as const;

    const parsed = AIVisibilityInputSchema.safeParse(base.input_snapshot);
    const outputParsed = AIVisibilityOutputSchema.safeParse(base.output);
    assert.ok(parsed.success, parsed.error?.message);
    assert.ok(outputParsed.success, outputParsed.error?.message);

    return { ...base, ...overrides };
}

test("deriveStartupId normalizes a startup name deterministically", () => {
    assert.equal(deriveStartupId("Acme Corp."), "acme_corp");
    assert.equal(deriveStartupId("  Foo   Bar  "), "foo_bar");
    assert.equal(deriveStartupId("XYZ"), "xyz");
});

test("persistVisibilityRun validates inputs and writes when repository succeeds", async () => {
    const repo = {
        saveRawResponses: async () => ({ inserted: 1, errors: [] }),
        saveParsedResults: async () => ({ inserted: 1, errors: [] }),
        saveRun: async () => ({ record_id: "record_1" }),
        getRunById: async () => null,
        getLatestRunForStartup: async () => null,
        ensureIndexes: async () => undefined,
    };

    const invalid = { run_id: "run_1" };
    const result = await persistVisibilityRun(invalid, { repository: repo });
    assert.deepEqual(result, {
        persisted: false,
        run_id: "run_1",
        inserted_raw: 0,
        inserted_parsed: 0,
        error: "validation_failed",
    });

    const valid = makeValidInput();
    const saveResult = await persistVisibilityRun(valid, { repository: repo });
    assert.equal(saveResult.persisted, true);
    assert.equal(saveResult.inserted_raw, 1);
    assert.equal(saveResult.inserted_parsed, 1);
    assert.equal(saveResult.record_id, "record_1");
});

test("persistVisibilityRun tool exposes LangChain metadata", () => {
    const repo = {
        ensureIndexes: async () => undefined,
        saveRawResponses: async () => ({ inserted: 1, errors: [] }),
        saveParsedResults: async () => ({ inserted: 1, errors: [] }),
        saveRun: async () => ({ record_id: "record_1" }),
        getRunById: async () => null,
        getLatestRunForStartup: async () => null,
    };

    const tool = createPersistVisibilityRunTool({ repository: repo });
    assert.equal(tool.name, "persist_visibility_run");
    assert.ok(typeof tool.description === "string" && tool.description.length > 0);
    assert.ok(tool.schema);
    assert.ok(persistVisibilityRunInputSchema.safeParse(makeValidInput()).success);
});
