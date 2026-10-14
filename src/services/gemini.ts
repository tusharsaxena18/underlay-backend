// src\services\gemini.ts
import {
    BaseChatModel,
    type BaseChatModelCallOptions,
    type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import type {
    BaseMessage,
    AIMessageChunk,
} from "@langchain/core/messages";
import type {
    ChatGenerationChunk,
    ChatResult,
} from "@langchain/core/outputs";
import { RunnableLambda, type Runnable } from "@langchain/core/runnables";
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

class RotatingGeminiModel extends BaseChatModel {
    private readonly modelName = "gemini-3.8-flash";
    private readonly temperature = 0.2;

    _llmType(): string {
        return "rotating-gemini";
    }

    bindTools(
        tools: BindToolsInput[],
        kwargs?: Partial<BaseChatModelCallOptions>,
    ): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions> {
        return RunnableLambda.from(async (input: BaseLanguageModelInput) => {
            const apiKey = geminiKeyManager.getNextKey();
            const model = new ChatGoogleGenerativeAI({
                model: this.modelName,
                apiKey,
                temperature: this.temperature,
            });

            return model.bindTools(tools, kwargs).invoke(input);
        });
    }

    async _generate(
        messages: BaseMessage[],
        options: this["ParsedCallOptions"],
        runManager?: any
    ): Promise<ChatResult> {
        const apiKey = geminiKeyManager.getNextKey();

        const model = new ChatGoogleGenerativeAI({
            model: this.modelName,
            apiKey,
            temperature: this.temperature,
        });

        const response = await model.invoke(messages as any);
        const content = response?.content;
        const text = typeof content === "string"
            ? content
            : Array.isArray(content)
                ? content.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("")
                : JSON.stringify(content ?? "");

        return {
            generations: [{
                text,
                message: response,
                generationInfo: {},
            }],
            llmOutput: {
                raw: response,
            },
        } as ChatResult;
    }
}

export function createGeminiModel(): BaseChatModel {
    return new RotatingGeminiModel({});
}