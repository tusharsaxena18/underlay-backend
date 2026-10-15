// src\tests\aiVisibility\tools\compareLongitudinalRuns.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import type { AIVisibilityOutput } from "../../../types/schema";
import { compareLongitudinalRuns } from "../../../agents/aiVisibility/tools/compareLongitudinalRuns";

function makeOutput(runId: string, mentionRate: number, modelMentionRate: number): AIVisibilityOutput {
    return {
        agent_name: "ai_visibility",
        status: "success",
        run_id: runId,
        startup_name: "Acme",
        tier: "1",
        generated_at: new Date("2025-01-01T00:00:00.000Z").toISOString(),
        findings: {
            summary: "Acme report",
            metrics: {
                mention_rate_by_model: { gemini: modelMentionRate },
                avg_position_score: 0.5,
                composite_visibility_score: 0.5,
            },
            flags: [],
        },
        scoring_details: {
            component_scores: {
                mention_rate: mentionRate,
                avg_position_score: 0.5,
                accuracy_score: 0.5,
                sentiment_score: 0.5,
                competitive_fairness_score: null,
            },
            weights_used: { mention_rate: 1 },
            coverage: 1,
            scoring_version: "v1",
            limitations: [],
        },
        confidence: 0.9,
        source_type: "verified",
        sources_used: ["gemini"],
        raw_trace_id: runId,
        limitations: [],
    };
}

test("compares flat metrics and preserved scoring details", async () => {
    const baselineOutput = makeOutput("run_old", 0.25, 0.25);
    const currentOutput = makeOutput("run_new", 0.75, 0.75);
    const result = await compareLongitudinalRuns({
        startup_id: "acme",
        current_run_id: currentOutput.run_id,
        current_output: { ...currentOutput, scoring_version: "v1" },
    }, {
        repository: {
            getRunById: async () => null,
            getLatestRunForStartup: async () => ({
                run_id: baselineOutput.run_id,
                scoring_version: "v1",
                output: baselineOutput,
            }),
        },
    });

    assert.equal(result.metric_deltas["mention_rate_by_model.gemini"], 0.5);
    assert.equal(result.metric_deltas["scoring_details.component_scores.mention_rate"], 0.5);
});

test("normalizes scoring details from persisted legacy reports", async () => {
    const currentOutput = makeOutput("run_new", 0.75, 0.75);
    const baselineBase = makeOutput("run_old", 0.25, 0.25);
    const legacyOutput = {
        ...baselineBase,
        findings: {
            ...baselineBase.findings,
            metrics: {
                component_scores: {
                    mention_rate: 0.25,
                    avg_position_score: 0.5,
                    accuracy_score: 0.5,
                    sentiment_score: 0.5,
                    competitive_fairness_score: null,
                },
                weights_used: { mention_rate: 1 },
                composite_visibility_score: 0.5,
                coverage: 1,
                scoring_version: "v1",
                limitations: [],
            },
        },
    } as unknown as AIVisibilityOutput;
    const result = await compareLongitudinalRuns({
        startup_id: "acme",
        current_run_id: currentOutput.run_id,
        current_output: { ...currentOutput, scoring_version: "v1" },
    }, {
        repository: {
            getRunById: async () => null,
            getLatestRunForStartup: async () => ({
                run_id: legacyOutput.run_id,
                scoring_version: "v1",
                output: legacyOutput,
            }),
        },
    });

    assert.equal(result.metric_deltas["scoring_details.component_scores.mention_rate"], 0.5);
});
