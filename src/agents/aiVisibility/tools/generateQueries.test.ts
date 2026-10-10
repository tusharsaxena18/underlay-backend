// src\agents\aiVisibility\tools\generateQueries.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
    competitorSlug,
    generateQueries,
    TIER_QUERY_LIMITS,
} from "./generateQueries";

const baseInput = {
    startup_name: " Acme   Labs ",
    icp: "small businesses",
    problem_statement: "manual invoice processing",
    category: "accounting automation",
    competitors: ["Acme Corp", "Beta Inc", "Gamma LLC", "Delta Ltd", "Epsilon"],
};

test("query generation is deterministic and normalizes substitutions", () => {
    const input = { ...baseInput, tier: "2" as const };
    assert.deepEqual(generateQueries(input), generateQueries(input));
    const result = generateQueries(input);
    assert.ok("queries" in result);
    assert.ok(result.queries.every((query) => !query.query.includes("  ")));
});

test("tier limits are editable and cap the startup query batch", () => {
    assert.deepEqual(TIER_QUERY_LIMITS, { "1": 3, "2": 5, "3": 7 });
    for (const [tier, expected] of [["1", 3], ["2", 5], ["3", 7]] as const) {
        const result = generateQueries({ ...baseInput, tier });
        assert.ok("queries" in result);
        assert.equal(result.queries.filter((query) => query.query_type !== "competitive").length, expected);
    }
});

test("tier 1 only emits direct and category discovery queries", () => {
    const result = generateQueries({ ...baseInput, tier: "1" });
    assert.ok("queries" in result);
    assert.ok(result.queries.every((query) =>
        query.query_type === "direct" || query.query_type === "category_discovery",
    ));
});

test("tier 2 excludes competitive queries and max_queries can lower the cap", () => {
    const result = generateQueries({ ...baseInput, tier: "2", max_queries: 2 });
    assert.ok("queries" in result);
    assert.equal(result.count, 2);
    assert.ok(result.queries.every((query) => query.query_type !== "competitive"));
});

test("tier 3 generates competitor queries separately and uses no more than three competitors", () => {
    const result = generateQueries({ ...baseInput, tier: "3" });
    assert.ok("queries" in result);
    const competitorQueries = result.queries.filter((query) => query.query_type === "competitive");
    assert.equal(competitorQueries.length, 6);
    assert.deepEqual(
        [...new Set(competitorQueries.map((query) => query.target_competitor))],
        ["Acme Corp", "Beta Inc", "Gamma LLC"],
    );
    assert.equal(result.count, 13);
});

test("tier 3 with no competitors still returns startup queries", () => {
    const result = generateQueries({ ...baseInput, competitors: [], tier: "3" });
    assert.ok("queries" in result);
    assert.equal(result.count, 7);
    assert.ok(result.queries.every((query) => query.query_type !== "competitive"));
});

test("query IDs are stable, family-specific, and competitor slugs are normalized", () => {
    const result = generateQueries({ ...baseInput, tier: "3" });
    assert.ok("queries" in result);
    assert.ok(result.queries.some((query) => query.query_id === "q_direct_1"));
    assert.ok(result.queries.some((query) => query.query_id === "q_competitive_acme_corp_1"));
    assert.equal(competitorSlug("Acme Corp"), "acme_corp");
});

test("invalid input returns a structured error", () => {
    assert.ok("error" in generateQueries({ ...baseInput, tier: "4" }));
});
