// src\services\providers\gemini.ts
import { createGeminiModel } from "../gemini";

export interface GeminiProviderOptions {
    timeoutMs?: number;
    temperature?: number;
    modelName?: string;
}

export interface GeminiProviderResult {
    text: string;
    citations?: string[];
    latency_ms: number;
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
                .filter((value): value is string => typeof value === "string");
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

    const response = await Promise.race([
        model.invoke(prompt),
        new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("timeout")), timeoutMs);
        }),
    ]).catch((error: unknown) => {
        if (error instanceof Error && error.message === "timeout") {
            throw error;
        }

        throw error;
    });

    const result = response as {
        content?: unknown;
        response_metadata?: Record<string, unknown>;
    };

    const text = coerceText(result.content);
    const citations = extractCitations(result.response_metadata);

    return {
        text,
        ...(citations && citations.length > 0 ? { citations } : {}),
        latency_ms: Date.now() - startedAt,
    };
}
