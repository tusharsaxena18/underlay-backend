// src\services\persistence\visibilityRunRepository.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import {
    DuplicateRunError,
    createVisibilityRunRepository,
    type VisibilityRunDocument,
} from "./visibilityRunRepository";

function createFakeDb() {
    const runDocs: Array<Record<string, unknown>> = [];
    const rawDocs: Array<Record<string, unknown>> = [];
    const parsedDocs: Array<Record<string, unknown>> = [];

    return {
        db: {
            collection: (name: string) => ({
                createIndex: async () => "index",
                findOne: async (query: Record<string, unknown>) => {
                    const target = name === "visibility_runs" ? runDocs : name === "visibility_raw_responses" ? rawDocs : parsedDocs;
                    return target.find((doc) => doc.run_id === query.run_id || doc.response_id === query.response_id) ?? null;
                },
                insertOne: async (doc: Record<string, unknown>) => {
                    const target = name === "visibility_runs" ? runDocs : name === "visibility_raw_responses" ? rawDocs : parsedDocs;
                    target.push({ ...doc, _id: { toString: () => `mock_${target.length + 1}` } });
                    return { insertedId: { toString: () => `mock_${target.length}` } };
                },
                insertMany: async (docs: Record<string, unknown>[]) => {
                    const target = name === "visibility_runs" ? runDocs : name === "visibility_raw_responses" ? rawDocs : parsedDocs;
                    for (const doc of docs) {
                        target.push({ ...doc, _id: { toString: () => `mock_${target.length + 1}` } });
                    }
                    return { insertedCount: docs.length };
                },
                find: (query: Record<string, unknown>) => ({
                    sort: () => ({
                        limit: () => ({
                            next: async () => {
                                const target = name === "visibility_runs" ? runDocs : [] as Record<string, unknown>[];
                                const startupId = query.startup_id as string | undefined;
                                if (!startupId) return null;
                                const matches = target.filter((doc) => doc.startup_id === startupId);
                                return matches[matches.length - 1] ?? null;
                            },
                        }),
                    }),
                }),
            }),
        },
    };
}

test("repository creates indexes, saves a run, and reads it back without ObjectId leakage", async () => {
    const { db } = createFakeDb();
    const repo = createVisibilityRunRepository(db as any);

    await repo.ensureIndexes();

    const run: VisibilityRunDocument = {
        run_id: "run_1",
        startup_id: "acme_corp",
        startup_name: "Acme Corp",
        tier: "2",
        scoring_version: "v1",
        started_at: "2025-01-01T00:00:00.000Z",
        completed_at: "2025-01-01T00:00:05.000Z",
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
            run_id: "run_1",
            startup_name: "Acme Corp",
            tier: "2",
            generated_at: "2025-01-01T00:00:06.000Z",
            findings: {
                summary: "ok",
                metrics: {
                    component_scores: {
                        mention_rate: 1,
                        avg_position_score: 1,
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
                    composite_visibility_score: 1,
                    coverage: 1,
                    scoring_version: "v1",
                    limitations: [],
                },
                flags: [],
                source_trace: [],
                consistency_issues: [],
            },
            confidence: 1,
            source_type: "verified",
            sources_used: ["google"],
            raw_trace_id: "run_1",
            limitations: [],
        },
        status: "success",
    };

    const saved = await repo.saveRun(run);
    const loaded = await repo.getRunById("run_1");

    assert.equal(saved.record_id.length > 0, true);
    assert.ok(loaded);
    assert.equal(loaded?.run_id, "run_1");
    assert.equal("_id" in (loaded as unknown as Record<string, unknown>), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loaded as unknown as object, "record_id"), true);
});

test("repository rejects duplicates and returns latest run for a startup", async () => {
    const { db } = createFakeDb();
    const repo = createVisibilityRunRepository(db as any);

    const firstRun: VisibilityRunDocument = {
        run_id: "run_duplicate_1",
        startup_id: "acme_corp",
        startup_name: "Acme Corp",
        tier: "2",
        scoring_version: "v1",
        started_at: "2025-01-01T00:00:00.000Z",
        completed_at: "2025-01-01T00:00:05.000Z",
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
            status: "partial",
            run_id: "run_duplicate_1",
            startup_name: "Acme Corp",
            tier: "2",
            generated_at: "2025-01-01T00:00:06.000Z",
            findings: {
                summary: "partial",
                metrics: {
                    component_scores: {
                        mention_rate: 1,
                        avg_position_score: 1,
                        accuracy_score: 1,
                        sentiment_score: 1,
                        competitive_fairness_score: 0.8,
                    },
                    weights_used: {
                        mention_rate: 0.4,
                        avg_position_score: 0.2,
                        accuracy_score: 0.2,
                        sentiment_score: 0.1,
                        competitive_fairness_score: 0.1,
                    },
                    composite_visibility_score: 0.9,
                    coverage: 1,
                    scoring_version: "v1",
                    limitations: [],
                },
                flags: [],
                source_trace: [],
                consistency_issues: [],
            },
            confidence: 0.9,
            source_type: "mixed",
            sources_used: ["google"],
            raw_trace_id: "run_duplicate_1",
            limitations: [],
        },
        status: "partial",
    };

    await repo.saveRun(firstRun);
    await assert.rejects(() => repo.saveRun(firstRun), DuplicateRunError);
    const latest = await repo.getLatestRunForStartup("acme_corp");
    assert.ok(latest);
    assert.equal(latest?.run_id, "run_duplicate_1");
});

test("repository handles partial raw and parsed inserts without erroring", async () => {
    const { db } = createFakeDb();
    const repo = createVisibilityRunRepository(db as any);

    const rawResult = await repo.saveRawResponses([
        {
            response_id: "raw_1",
            run_id: "run_1",
            query_id: "q_1",
            provider: "google",
            status: "success",
            response_text: "hello",
            citations: ["https://example.com"],
            captured_at: "2025-01-01T00:00:00.000Z",
        },
    ]);
    const parsedResult = await repo.saveParsedResults([
        {
            response_id: "raw_1",
            run_id: "run_1",
            query_id: "q_1",
            provider: "google",
            startup_mentioned: true,
            mention_count: 1,
            first_mention_position: 1,
            position_score: 1,
            sentiment: "positive",
            framing: "hello",
            claims: [],
            citations: ["https://example.com"],
            parse_confidence: 1,
        },
    ]);

    assert.equal(rawResult.inserted, 1);
    assert.equal(parsedResult.inserted, 1);
});
