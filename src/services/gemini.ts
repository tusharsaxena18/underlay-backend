import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { GeminiKeyManager } from "./keyManager";

function loadGeminiKeys(): string[] {
    return Object.entries(process.env)
        .filter(([key]) => /^GEMINI_KEY_\d+$/.test(key))
        .sort(([a], [b]) => {
            const aNumber = Number(a.replace("GEMINI_KEY_", ""));
            const bNumber = Number(b.replace("GEMINI_KEY_", ""));

            return aNumber - bNumber;
        })
        .map(([, value]) => value)
        .filter((value): value is string => Boolean(value));
}

const geminiKeyManager = new GeminiKeyManager(loadGeminiKeys());

export function createGeminiModel() {
    const apiKey = geminiKeyManager.getNextKey();

    return new ChatGoogleGenerativeAI({
        model: "gemini-3.8-flash",
        apiKey,
        temperature: 0.2,
    });
}