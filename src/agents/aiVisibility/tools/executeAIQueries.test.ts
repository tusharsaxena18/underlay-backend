// src\agents\aiVisibility\tools\executeAIQueries.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { GeminiKeyManager } from "../../../services/keyManager";
import { callGeminiProvider, createGeminiModel } from "../../../services/gemini";
import { executeAIQueries } from "./executeAIQueries";

function resetGeminiEnv() {
    process.env.GEMINI_KEY_1 = "k1";
    process.env.GEMINI_KEY_2 = "k2";
    process.env.GEMINI_KEY_3 = "k3";
}

test("key rotation starts after construction and advances per request", async () => {
    resetGeminiEnv();
    const originalGetNextKey = GeminiKeyManager.prototype.getNextKey;
    const sequence: string[] = [];

    GeminiKeyManager.prototype.getNextKey = function () {
        const key = originalGetNextKey.call(this);
        sequence.push(key);
        return key;
    };

    const originalInvoke = ChatGoogleGenerativeAI.prototype.invoke;
    (ChatGoogleGenerativeAI.prototype as any).invoke = async function () {
        return { content: "ok" };
    };

    try {
        const model = createGeminiModel();
        assert.deepEqual(sequence, []);

        await callGeminiProvider("first query", { timeoutMs: 1000 });
        await callGeminiProvider("second query", { timeoutMs: 1000 });
        assert.deepEqual(sequence, ["k1", "k2"]);
        assert.ok(model !== null);
    } finally {
        GeminiKeyManager.prototype.getNextKey = originalGetNextKey;
        (ChatGoogleGenerativeAI.prototype as any).invoke = originalInvoke;
    }
});

test("rejects provider selections other than Gemini", async () => {
    const result = await executeAIQueries({
        run_id: "run_42",
        queries: [{ query_id: "q1", query: "Who is Acme?", target_startup: "Acme" }],
        providers: ["openai"],
        tier: "1",
    }, {
        geminiProvider: async () => {
            throw new Error("Gemini should not be called for invalid provider selection");
        },
    });

    assert.deepEqual(result, { results: [], provider_summary: [] });
});
