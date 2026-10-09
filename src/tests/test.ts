// src\tests\test.ts
import dotenv from "dotenv";
import { createGeminiModel } from "../services/gemini";

dotenv.config();

async function main() {
    const rootStart = performance.now();
    for (let i = 1; i <= 4; i++) {
        try {
            const start = performance.now();
            const model = createGeminiModel();
            const response = await model.invoke(
                `Reply with exactly: Request ${i} successful.`
            );

            const end = performance.now();

            console.log(`Response ${i}:`, response.content);
            console.log(`Time: ${(end - start).toFixed(0)} ms`);
            console.log("---");
        } catch (error) {
            console.error(`Request ${i} failed:`, error);
        }
    }
    const rootEnd = performance.now();
    console.log(`Total time: ${(rootEnd - rootStart).toFixed(0)} ms`);
}

main();