// src\tests\aiVisibility\aiVisibilityAgent.live.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { runAIVisibilityAgent } from "../../agents/aiVisibility/aiVisibilityAgent";
import { generateQueries } from "../../agents/aiVisibility/tools/generateQueries";
import type { AIVisibilityInput } from "../../types/schema";

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

for (const tier of ["1", "2", "3"] as const) {
    test(`live Gemini AI visibility run for Tier ${tier}`, { timeout: 180_000 }, async () => {
        const input: AIVisibilityInput = {
            ...baseInput,
            tier,
            ...(tier === "3" ? {} : { competitors: [] }),
        };
        const output = await runAIVisibilityAgent(input, {
            persist: false,
            maxConcurrency: 1,
            timeoutMs: 60_000,
            tools: {
                generateQueries: {
                    invoke: async (queryInput: unknown) => {
                        if (typeof queryInput !== "object" || queryInput === null) {
                            throw new Error("Query generator received invalid input.");
                        }
                        return generateQueries(queryInput);
                    },
                },
            },
        });

        console.log(`Tier ${tier} output:\n${JSON.stringify(output, null, 2)}`);

        assert.equal(output.tier, tier);
        assert.ok(
            output.sources_used.includes("gemini"),
            [
                `Expected Tier ${tier} to include at least one successful response from Gemini.`,
                `Agent status: ${output.status}.`,
                `Limitations: ${output.limitations.join("; ") || "none"}.`,
            ].join(" "),
        );
    });
}
