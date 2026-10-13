// src\agents\aiVisibility\tools\executeAIQueries.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { GeminiKeyManager } from "../../../services/keyManager";
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
        const geminiModulePath = require.resolve("../../../services/gemini");
        delete require.cache[geminiModulePath];
        const providerModulePath = require.resolve("../../../services/providers/gemini");
        delete require.cache[providerModulePath];
        const { createGeminiModel } = require("../../../services/gemini");
        const { callGeminiProvider } = require("../../../services/providers/gemini") as {
            callGeminiProvider: (prompt: string, options?: { timeoutMs?: number }) => Promise<{ text: string; citations?: string[]; latency_ms: number }>;
        };
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

test("unimplemented providers are skipped and summary reflects partial success", async () => {
    const result = await executeAIQueries({
        run_id: "run_42",
        queries: [
            { query_id: "q1", query: "Who is Acme?", target_startup: "Acme" },
            { query_id: "q2", query: "What does Acme do?", target_startup: "Acme" },
        ],
        providers: ["gemini", "openai"],
        tier: "1",
        max_concurrency: 2,
        timeout_ms: 2000,
    }, {
        geminiProvider: async (prompt: string) => ({
            text: `Gemini answer for ${prompt}`,
            citations: ["https://example.com/gemini"],
            latency_ms: 25,
        }),
    });

    assert.equal(result.results.filter((entry) => entry.status === "success").length, 2);
    assert.equal(result.provider_summary.find((entry) => entry.provider === "gemini")?.succeeded, 2);
    assert.equal(result.provider_summary.find((entry) => entry.provider === "openai")?.failed, 2);
    assert.ok(result.results.some((entry) => entry.response_id.includes("openai_q1")));
});
