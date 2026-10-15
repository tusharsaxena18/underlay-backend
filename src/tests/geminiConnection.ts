// src\tests\geminiConnection.ts
import { callGeminiProvider } from "../services/gemini";

async function main(): Promise<void> {
    try {
        const response = await callGeminiProvider(
            "Hey, How are you?",
        );

        if (!response.text.trim()) {
            throw new Error("Gemini returned an empty response.");
        }

        console.log("Gemini connection successful.");
        console.log(`Response: ${response.text}`);
        console.log(`Latency: ${response.latency_ms} ms`);
    } catch (error) {
        console.error("Gemini connection test failed:", error);
        process.exitCode = 1;
    }
}

void main();
