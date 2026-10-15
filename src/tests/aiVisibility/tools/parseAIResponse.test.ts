// src\tests\aiVisibility\tools\parseAIResponse.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

const baseGroundTruth = {
    product_description: "AI workflow automation",
    pricing_model: "usage-based",
    founding_year: 2021,
    key_differentiators: ["workflow automation", "data-rich insights"],
    current_stage: "seed",
    website_url: "https://example.com",
    last_verified_at: "2025-01-01T00:00:00.000Z",
};

function makeModel(behavior: Array<unknown>) {
    let index = 0;
    const calls: string[] = [];

    return {
        calls,
        withStructuredOutput: () => ({
            invoke: async (prompt: string) => {
                calls.push(prompt);
                const next = behavior[index] ?? behavior[behavior.length - 1];
                index += 1;
                return next;
            },
        }),
    };
}

function loadParserModule() {
    process.env.GEMINI_KEY_1 = "k1";
    process.env.GEMINI_KEY_2 = "k2";
    process.env.GEMINI_KEY_3 = "k3";
    const geminiModulePath = require.resolve("../../../services/gemini");
    delete require.cache[geminiModulePath];
    const parserModulePath = require.resolve("../../../agents/aiVisibility/tools/parseAIResponse");
    delete require.cache[parserModulePath];
    return require("../../../agents/aiVisibility/tools/parseAIResponse") as {
        calculatePositionScore: (position: number | null) => number | null;
        parseAIResponse: (...args: any[]) => Promise<any>;
        ParsedResponseSchema: { safeParse: (value: unknown) => { success: boolean } };
    };
}

test("happy path response is parsed with valid claims", async () => {
    const { parseAIResponse } = loadParserModule();
    const model = makeModel([
        {
            startup_mentioned: true,
            mention_count: 2,
            first_mention_position: 1,
            sentiment: "positive",
            framing: "category leader",
            claims: [
                {
                    field: "product_description",
                    claim: "Acme helps automate workflows.",
                    polarity: "supports",
                    matches_ground_truth: "yes",
                    evidence_quote: "Acme helps automate workflows.",
                    confidence: 0.9,
                },
                {
                    field: "pricing_model",
                    claim: "It uses a usage-based model.",
                    polarity: "supports",
                    matches_ground_truth: "yes",
                    evidence_quote: "usage-based pricing",
                    confidence: 0.8,
                },
            ],
            citations: ["https://example.com/a"],
        },
    ]);

    const result = await parseAIResponse({
        startup_name: "Acme",
        ground_truth: baseGroundTruth,
        responses: [{
            response_id: "resp_1",
            provider: "gemini",
            query_id: "q1",
            response_text: "Paragraph one: Acme helps automate workflows.\n\nParagraph two: It has usage-based pricing.",
            citations: ["https://example.com/a"],
        }],
    }, { model });

    const parsed = result.parsed[0];
    assert.equal(result.errors.length, 0);
    assert.ok(parsed);
    assert.equal(parsed.startup_mentioned, true);
    assert.equal(parsed.claims.length, 2);
    assert.equal(parsed.parse_confidence > 0.5, true);
});

test("not mentioned startup yields empty mention fields", async () => {
    const { parseAIResponse } = loadParserModule();
    const model = makeModel([{ startup_mentioned: false, mention_count: 0, first_mention_position: null, sentiment: "neutral", framing: "not mentioned", claims: [], citations: [] }]);
    const result = await parseAIResponse({
        startup_name: "Acme",
        ground_truth: baseGroundTruth,
        responses: [{
            response_id: "resp_2",
            provider: "gemini",
            query_id: "q2",
            response_text: "This is a general overview of workflow automation.",
        }],
    }, { model });

    const parsed = result.parsed[0];
    assert.ok(parsed);
    assert.equal(parsed.startup_mentioned, false);
    assert.equal(parsed.mention_count, 0);
    assert.equal(parsed.first_mention_position, null);
    assert.equal(parsed.position_score, null);
});

test("retry on malformed output succeeds and reduces confidence", async () => {
    const { parseAIResponse } = loadParserModule();
    const model = makeModel([
        { bad: "shape" },
        {
            startup_mentioned: true,
            mention_count: 1,
            first_mention_position: 2,
            sentiment: "positive",
            framing: "leader",
            claims: [],
            citations: [],
        },
    ]);

    const result = await parseAIResponse({
        startup_name: "Acme",
        ground_truth: baseGroundTruth,
        responses: [{
            response_id: "resp_3",
            provider: "gemini",
            query_id: "q3",
            response_text: "First paragraph\n\nAcme leads the category.",
        }],
    }, { model });

    assert.equal(result.parsed.length, 1);
    assert.ok(result.parsed[0]?.parse_confidence < 1);
});

test("two malformed outputs are reported as errors", async () => {
    const { parseAIResponse } = loadParserModule();
    const model = makeModel([
        { bad: "shape" },
        { bad: "shape" },
    ]);

    const result = await parseAIResponse({
        startup_name: "Acme",
        ground_truth: baseGroundTruth,
        responses: [{
            response_id: "resp_4",
            provider: "gemini",
            query_id: "q4",
            response_text: "Acme is here.",
        }],
    }, { model });

    assert.equal(result.errors.length, 1);
    assert.equal(result.parsed.length, 0);
});

test("invalid evidence quote is cleared and confidence reduced", async () => {
    const { parseAIResponse } = loadParserModule();
    const model = makeModel([{
        startup_mentioned: true,
        mention_count: 1,
        first_mention_position: 1,
        sentiment: "positive",
        framing: "leader",
        claims: [{
            field: "product_description",
            claim: "Acme helps automate workflows.",
            polarity: "supports",
            matches_ground_truth: "yes",
            evidence_quote: "not present in text",
            confidence: 0.8,
        }],
        citations: [],
    }]);

    const result = await parseAIResponse({
        startup_name: "Acme",
        ground_truth: baseGroundTruth,
        responses: [{
            response_id: "resp_5",
            provider: "gemini",
            query_id: "q5",
            response_text: "Acme is a workflow tool.",
        }],
    }, { model });

    const parsed = result.parsed[0];
    assert.ok(parsed);
    assert.equal(parsed.claims[0]?.evidence_quote, undefined);
    assert.ok(parsed.parse_confidence < 1);
});

test("invalid sentiment string is coerced to not_applicable", async () => {
    const { parseAIResponse } = loadParserModule();
    const model = makeModel([{
        startup_mentioned: true,
        mention_count: 1,
        first_mention_position: 1,
        sentiment: "favorable",
        framing: "leader",
        claims: [],
        citations: [],
    }]);

    const result = await parseAIResponse({
        startup_name: "Acme",
        ground_truth: baseGroundTruth,
        responses: [{
            response_id: "resp_6",
            provider: "gemini",
            query_id: "q6",
            response_text: "Acme is a workflow tool.",
        }],
    }, { model });

    const parsed = result.parsed[0];
    assert.ok(parsed);
    assert.equal(parsed.sentiment, "not_applicable");
    assert.ok(parsed.parse_confidence < 1);
});

test("position score mapping follows the specified values", () => {
    const { calculatePositionScore } = loadParserModule();
    assert.equal(calculatePositionScore(1), 1);
    assert.equal(calculatePositionScore(2), 0.85);
    assert.equal(calculatePositionScore(3), 0.7);
    assert.equal(calculatePositionScore(4), 0.55);
    assert.equal(calculatePositionScore(5), 0.45);
    assert.equal(calculatePositionScore(10), 0.1);
    assert.equal(calculatePositionScore(null), null);
});

test("citations passthrough exactly from input", async () => {
    const { parseAIResponse } = loadParserModule();
    const model = makeModel([{
        startup_mentioned: true,
        mention_count: 1,
        first_mention_position: 1,
        sentiment: "neutral",
        framing: "category leader",
        claims: [],
        citations: ["https://example.com/a"],
    }]);

    const result = await parseAIResponse({
        startup_name: "Acme",
        ground_truth: baseGroundTruth,
        responses: [{
            response_id: "resp_7",
            provider: "gemini",
            query_id: "q7",
            response_text: "Acme is a workflow automation tool.",
            citations: ["https://example.com/a", "https://example.com/b"],
        }],
    }, { model });

    const parsed = result.parsed[0];
    assert.ok(parsed);
    assert.deepEqual(parsed.citations, ["https://example.com/a", "https://example.com/b"]);
});

test("parse confidence is deterministic for the same model output", async () => {
    const { parseAIResponse } = loadParserModule();
    const model = makeModel([{
        startup_mentioned: true,
        mention_count: 1,
        first_mention_position: 1,
        sentiment: "positive",
        framing: "leader",
        claims: [{
            field: "product_description",
            claim: "Acme helps automate workflows.",
            polarity: "supports",
            matches_ground_truth: "yes",
            evidence_quote: "Acme helps automate workflows.",
            confidence: 0.8,
        }],
        citations: [],
    }]);

    const first = await parseAIResponse({
        startup_name: "Acme",
        ground_truth: baseGroundTruth,
        responses: [{
            response_id: "resp_8",
            provider: "gemini",
            query_id: "q8",
            response_text: "Acme helps automate workflows.",
        }],
    }, { model });
    const second = await parseAIResponse({
        startup_name: "Acme",
        ground_truth: baseGroundTruth,
        responses: [{
            response_id: "resp_8b",
            provider: "gemini",
            query_id: "q8b",
            response_text: "Acme helps automate workflows.",
        }],
    }, { model });

    const firstParsed = first.parsed[0];
    const secondParsed = second.parsed[0];
    assert.ok(firstParsed);
    assert.ok(secondParsed);
    assert.equal(firstParsed.parse_confidence, secondParsed.parse_confidence);
});

test("prompt includes startup name and ground truth, and is stable across calls", async () => {
    const { parseAIResponse } = loadParserModule();
    const model = makeModel([{
        startup_mentioned: true,
        mention_count: 1,
        first_mention_position: 1,
        sentiment: "positive",
        framing: "leader",
        claims: [],
        citations: [],
    }]);

    const first = await parseAIResponse({
        startup_name: "Acme",
        ground_truth: baseGroundTruth,
        responses: [{
            response_id: "resp_9",
            provider: "gemini",
            query_id: "q9",
            response_text: "Acme is a workflow tool.",
        }],
    }, { model });

    const promptText = model.calls[0];
    assert.ok(promptText);
    assert.ok(promptText.includes("Acme"));
    assert.ok(promptText.includes("product_description"));
    assert.ok(promptText.includes("AI workflow automation"));
    assert.ok(first.parsed[0]);
});

test("empty claims array is valid", async () => {
    const { parseAIResponse } = loadParserModule();
    const model = makeModel([{
        startup_mentioned: true,
        mention_count: 1,
        first_mention_position: 1,
        sentiment: "neutral",
        framing: "niche player",
        claims: [],
        citations: [],
    }]);

    const result = await parseAIResponse({
        startup_name: "Acme",
        ground_truth: baseGroundTruth,
        responses: [{
            response_id: "resp_10",
            provider: "gemini",
            query_id: "q10",
            response_text: "Acme is a workflow tool.",
        }],
    }, { model });

    const parsed = result.parsed[0];
    assert.ok(parsed);
    assert.deepEqual(parsed.claims, []);
});

test("structured output schema can be parsed by zod", () => {
    const { ParsedResponseSchema } = loadParserModule();
    const parsed = ParsedResponseSchema.safeParse({
        startup_mentioned: true,
        mention_count: 1,
        first_mention_position: 1,
        sentiment: "positive",
        framing: "leader",
        claims: [],
        citations: [],
    });

    assert.equal(parsed.success, true);
});
