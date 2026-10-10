// src\agents\aiVisibility\tools\assembleReport.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { AIVisibilityOutputSchema } from "../../../types/schema";
import { assembleReport } from "./assembleReport";

const scoreResult = {
    component_scores: {
        mention_rate: 0.8,
        avg_position_score: 0.6,
        accuracy_score: 1,
        sentiment_score: 0.4,
        competitive_fairness_score: null,
    },
    weights_used: {
        mention_rate: 0.29411764705882354,
        avg_position_score: 0.23529411764705882,
        accuracy_score: 0.29411764705882354,
        sentiment_score: 0.17647058823529413,
    },
    composite_visibility_score: 0.6941176470588235,
    coverage: 1,
    scoring_version: "v1",
    limitations: [],
};

const baseInput = {
    run_id: "run-123",
    startup_name: "Acme",
    tier: "1",
    provider_summary: [{ provider: "gemini", attempted: 2, succeeded: 2, failed: 0 }],
    parsed_results: [
        { response_id: "response-1", provider: "gemini", startup_mentioned: true, parse_confidence: 1 },
        { response_id: "response-2", provider: "gemini", startup_mentioned: false, parse_confidence: 1 },
    ],
    score_result: scoreResult,
    ground_truth_completeness: 0.8,
    query_coverage_vs_tier_target: 1,
};

test("assembles and validates a successful report", () => {
    const result = assembleReport(baseInput);
    assert.ok("findings" in result);
    assert.equal(result.status, "success");
    assert.equal(result.source_type, "verified");
    assert.equal(result.confidence, 0.96);
    assert.deepEqual(AIVisibilityOutputSchema.parse(result), result);
});

test("all failed providers produce a failed, unverified report", () => {
    const result = assembleReport({
        ...baseInput,
        provider_summary: [{ provider: "gemini", attempted: 2, succeeded: 0, failed: 2 }],
        parsed_results: [],
    });
    assert.ok("findings" in result);
    assert.equal(result.status, "failed");
    assert.equal(result.source_type, "unverified");
});

test("provider failures and null metrics produce a partial report with limitations", () => {
    const result = assembleReport({
        ...baseInput,
        provider_summary: [
            { provider: "gemini", attempted: 2, succeeded: 1, failed: 1 },
            { provider: "openai", attempted: 1, succeeded: 1, failed: 0 },
        ],
        score_result: {
            ...scoreResult,
            component_scores: { ...scoreResult.component_scores, accuracy_score: null },
        },
    });
    assert.ok("findings" in result);
    assert.equal(result.status, "partial");
    assert.ok(result.limitations.some((limitation) => limitation.includes("accuracy_score")));
});

test("respects a verbatim summary override and lists only successful providers", () => {
    const result = assembleReport({
        ...baseInput,
        summary_override: "  Exact summary  ",
        provider_summary: [
            ...baseInput.provider_summary,
            { provider: "openai", attempted: 1, succeeded: 0, failed: 1 },
        ],
    });
    assert.ok("findings" in result);
    assert.equal(result.findings.summary, "  Exact summary  ");
    assert.deepEqual(result.sources_used, ["gemini"]);
});

test("generates a deterministic summary and defaults flags and confidence inputs", () => {
    const { ground_truth_completeness: _groundTruth, query_coverage_vs_tier_target: _coverage, ...input } = baseInput;
    const result = assembleReport(input);
    assert.ok("findings" in result);
    assert.equal(
        result.findings.summary,
        "Acme was mentioned in 1/2 successful responses across 1 provider(s). Composite visibility score: 0.6941176470588235.",
    );
    assert.deepEqual(result.findings.flags, []);
    assert.ok(result.limitations.some((limitation) => limitation.includes("Default ground_truth_completeness")));
    assert.ok(result.limitations.some((limitation) => limitation.includes("Default query_coverage_vs_tier_target")));
});

test("confidence is clamped and invalid inputs return structured errors", () => {
    const result = assembleReport({
        ...baseInput,
        ground_truth_completeness: 3,
        query_coverage_vs_tier_target: 5,
    });
    assert.ok("findings" in result);
    assert.equal(result.confidence, 1);
    assert.ok("error" in assembleReport({ ...baseInput, tier: "invalid" }));
});
