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
import type { ChatResult } from "@langchain/core/outputs";
import { RunnableLambda, type Runnable } from "@langchain/core/runnables";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { GeminiKeyManager } from "./keyManager";

export interface GeminiProviderOptions {
    timeoutMs?: number;
}

export interface GeminiProviderResult {
    text: string;
    citations?: string[];
    latency_ms: number;
}

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

let geminiKeyManager: GeminiKeyManager | undefined;

function getGeminiKeyManager(): GeminiKeyManager {
    geminiKeyManager ??= new GeminiKeyManager(loadGeminiKeys());
    return geminiKeyManager;
}

class RotatingGeminiModel extends BaseChatModel {
    private readonly modelName = "gemini-3.1-flash-lite";
    private readonly temperature = 0.2;

    _llmType(): string {
        return "rotating-gemini";
    }

    bindTools(
        tools: BindToolsInput[],
        kwargs?: Partial<BaseChatModelCallOptions>,
    ): Runnable<BaseLanguageModelInput, AIMessageChunk, BaseChatModelCallOptions> {
        return RunnableLambda.from(async (input: BaseLanguageModelInput) => {
            const apiKey = getGeminiKeyManager().getNextKey();
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
        const apiKey = getGeminiKeyManager().getNextKey();

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

function coerceText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (Array.isArray(value)) {
        return value
            .map((item) => {
                if (typeof item === "string") {
                    return item;
                }

                if (item && typeof item === "object") {
                    const text = (item as { text?: unknown }).text;
                    return typeof text === "string" ? text : JSON.stringify(item);
                }

                return String(item);
            })
            .join("\n");
    }

    if (value && typeof value === "object") {
        const text = (value as { text?: unknown }).text;
        if (typeof text === "string") {
            return text;
        }

        const content = (value as { content?: unknown }).content;
        if (typeof content === "string") {
            return content;
        }
    }

    return String(value ?? "");
}

function extractCitations(metadata: Record<string, unknown> | undefined): string[] | undefined {
    if (!metadata) {
        return undefined;
    }

    const direct = metadata.citations;
    if (Array.isArray(direct)) {
        return direct.filter((item): item is string => typeof item === "string");
    }

    const citationMetadata = metadata.citationMetadata;
    if (citationMetadata && typeof citationMetadata === "object") {
        const candidate = (citationMetadata as { citations?: unknown }).citations;
        if (Array.isArray(candidate)) {
            return candidate.filter((item): item is string => typeof item === "string");
        }
    }

    const groundingMetadata = metadata.groundingMetadata;
    if (groundingMetadata && typeof groundingMetadata === "object") {
        const groundingList = (groundingMetadata as { groundingChunks?: unknown[] }).groundingChunks;
        if (Array.isArray(groundingList)) {
            return groundingList
                .map((chunk) => {
                    if (chunk && typeof chunk === "object") {
                        const uri = (chunk as { web?: { uri?: unknown } }).web?.uri;
                        if (typeof uri === "string") {
                            return uri;
                        }
                    }
                    return undefined;
                })
                .filter((item): item is string => typeof item === "string");
        }
    }

    return undefined;
}

export async function callGeminiProvider(
    prompt: string,
    options: GeminiProviderOptions = {},
): Promise<GeminiProviderResult> {
    const startedAt = Date.now();
    const model = createGeminiModel();
    const timeoutMs = Math.max(1, options.timeoutMs ?? 30000);
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
        const response = await Promise.race([
            model.invoke(prompt),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs);
            }),
        ]);
        const result = response as {
            content?: unknown;
            response_metadata?: Record<string, unknown>;
        };
        const citations = extractCitations(result.response_metadata);

        return {
            text: coerceText(result.content),
            ...(citations && citations.length > 0 ? { citations } : {}),
            latency_ms: Date.now() - startedAt,
        };
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}