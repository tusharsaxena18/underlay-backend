// src\agents\aiVisibility\tools\calculateVisibilityScore.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
    calculateVisibilityScore,
    SCORING_VERSION,
} from "./calculateVisibilityScore";

const allScores = {
    mention_rate: 0.8,
    avg_position_score: 0.6,
    accuracy_score: 1,
    sentiment_score: 0.4,
    competitive_fairness_score: 0.2,
};

test("tier 3 computes a full weighted score with full coverage", () => {
    const result = calculateVisibilityScore({ ...allScores, tier: "3" });
    assert.ok("component_scores" in result);
    assert.ok(Math.abs(result.composite_visibility_score! - 0.66) < 1e-12);
    assert.equal(result.coverage, 1);
    assert.equal(SCORING_VERSION, "v1");
});

test("tier 1 and tier 2 ignore competitive fairness", () => {
    const result = calculateVisibilityScore({ ...allScores, tier: "2" });
    assert.ok("component_scores" in result);
    assert.equal(result.component_scores.competitive_fairness_score, null);
    assert.equal(result.coverage, 1);
    assert.equal(Object.keys(result.weights_used).length, 4);
});

test("null metrics are excluded and remaining weights are renormalized", () => {
    const result = calculateVisibilityScore({
        ...allScores,
        sentiment_score: null,
        tier: "3",
    });
    assert.ok("component_scores" in result);
    assert.equal(result.coverage, 0.85);
    assert.ok(Math.abs(Object.values(result.weights_used).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
    assert.ok(result.limitations.includes("Missing metric: sentiment_score"));
});

test("all null metrics produce no composite and zero coverage", () => {
    const result = calculateVisibilityScore({
        mention_rate: null,
        avg_position_score: null,
        accuracy_score: null,
        sentiment_score: null,
        competitive_fairness_score: null,
        tier: "3",
    });
    assert.ok("component_scores" in result);
    assert.equal(result.composite_visibility_score, null);
    assert.equal(result.coverage, 0);
    assert.deepEqual(result.weights_used, {});
    assert.ok(result.limitations.includes("No metrics available to score"));
});

test("out-of-range metrics are clamped and reported", () => {
    const result = calculateVisibilityScore({
        ...allScores,
        mention_rate: 1.5,
        tier: "3",
    });
    assert.ok("component_scores" in result);
    assert.equal(result.component_scores.mention_rate, 1);
    assert.ok(result.limitations.includes("Metric mention_rate was clamped to [0, 1]"));
});

test("score calculation is deterministic and reports the scoring version", () => {
    const input = { ...allScores, tier: "3" as const };
    const first = calculateVisibilityScore(input);
    assert.deepEqual(first, calculateVisibilityScore(input));
    assert.ok("scoring_version" in first);
    assert.equal(first.scoring_version, "v1");
});

test("invalid input returns a structured error", () => {
    assert.ok("error" in calculateVisibilityScore({ tier: "bad" }));
});
