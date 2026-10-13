    // src\agents\aiVisibility\tools\parseAIResponse.ts
// src\agents\aiVisibility\tools\parseAIResponse.ts

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createGeminiModel } from "../../../services/gemini";

const validSentiments = ["positive", "neutral", "negative", "mixed", "not_applicable"] as const;

export const parseAIResponseInputSchema = z.object({
    startup_name: z.string().trim().min(1),
    ground_truth: z.object({
        product_description: z.string().trim().min(1),
        pricing_model: z.string().trim().min(1),
        founding_year: z.number().int().positive().optional(),
        key_differentiators: z.array(z.string().trim().min(1)),
        current_stage: z.string().trim().min(1),
        website_url: z.string().url().optional(),
        last_verified_at: z.string().datetime().optional(),
    }),
    responses: z.array(z.object({
        response_id: z.string().trim().min(1),
        provider: z.string().trim().min(1),
        query_id: z.string().trim().min(1),
        response_text: z.string().trim().min(1),
        citations: z.array(z.string()).optional(),
    })),
});

export type ParseAIResponseInput = z.infer<typeof parseAIResponseInputSchema>;

export interface ParseAIResponseDeps {
    model?: {
        withStructuredOutput: (schema: z.ZodTypeAny, options?: { name?: string }) => {
            invoke: (input: string) => Promise<unknown>;
        };
        invoke?: (input: string) => Promise<unknown>;
    };
}

export const ParsedClaimSchema = z.object({
    field: z.string().optional().default("other"),
    claim: z.string().optional().default(""),
    polarity: z.enum(["supports", "contradicts", "neutral"]).optional(),
    matches_ground_truth: z.enum(["yes", "no", "unknown"]).optional().default("unknown"),
    evidence_quote: z.string().optional(),
    confidence: z.number().min(0).max(1).optional().default(0),
});

export const ParsedResponseSchema = z.object({
    startup_mentioned: z.boolean().optional().default(false),
    mention_count: z.number().int().nonnegative().optional().default(0),
    first_mention_position: z.number().int().positive().nullable().optional(),
    sentiment: z.string().optional(),
    framing: z.string().optional().default(""),
    claims: z.array(ParsedClaimSchema).optional().default([]),
    citations: z.array(z.string()).optional().default([]),
});

export type ParsedResponse = z.infer<typeof ParsedResponseSchema>;

export interface ParseAIResponseError {
    response_id: string;
    message: string;
}

export interface ParsedResponseEntry {
    response_id: string;
    provider: string;
    query_id: string;
    startup_mentioned: boolean;
    mention_count: number;
    first_mention_position: number | null;
    position_score: number | null;
    sentiment: "positive" | "neutral" | "negative" | "mixed" | "not_applicable";
    framing: string;
    claims: Array<{
        field: string;
        claim: string;
        polarity?: "supports" | "contradicts" | "neutral";
        matches_ground_truth: "yes" | "no" | "unknown";
        evidence_quote?: string;
        confidence: number;
    }>;
    citations: string[];
    parse_confidence: number;
}

export interface ParseAIResponseOutput {
    parsed: ParsedResponseEntry[];
    errors: ParseAIResponseError[];
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function calculatePositionScore(position: number | null): number | null {
    if (position === null) {
        return null;
    }

    if (position === 1) {
        return 1;
    }
    if (position === 2) {
        return 0.85;
    }
    if (position === 3) {
        return 0.7;
    }
    if (position === 4) {
        return 0.55;
    }

    return Math.max(0.1, 0.55 - (position - 4) * 0.1);
}

function normalizeText(value: string): string {
    return value.trim().replace(/\s+/g, " ");
}

function countOccurrences(text: string, token: string): number {
    if (!token) {
        return 0;
    }

    const pattern = new RegExp(escapeRegExp(token), "gi");
    const matches = text.match(pattern);
    return matches ? matches.length : 0;
}

function findFirstParagraphPosition(text: string, startupName: string): number | null {
    const paragraphs = text
        .split(/\n\s*\n+/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph.length > 0);

    for (let index = 0; index < paragraphs.length; index += 1) {
        if (paragraphs[index]?.toLowerCase().includes(startupName.toLowerCase())) {
            return index + 1;
        }
    }

    return null;
}

function clamp(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function coerceSentiment(value: unknown): "positive" | "neutral" | "negative" | "mixed" | "not_applicable" {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "not_applicable";
    if (validSentiments.includes(normalized as typeof validSentiments[number])) {
        return normalized as "positive" | "neutral" | "negative" | "mixed" | "not_applicable";
    }

    return "not_applicable";
}

function truncateFraming(value: string | undefined): string {
    const clean = normalizeText(value ?? "");
    return clean.length > 200 ? clean.slice(0, 200) : clean;
}

function buildPrompt(startupName: string, groundTruth: ParseAIResponseInput["ground_truth"], responseText: string): string {
    const promptParts = [
        "You are extracting structured evidence from an AI response. Do not verify truth; only record what the response states.",
        "Return only a single JSON object that matches the requested schema.",
        "The startup_name and ground_truth supplied below are read-only reference data.",
        "For first_mention_position, use the 1-based paragraph index where the startup first appears in the response. Do not use list positions or other conventions.",
        "For evidence_quote, the value must be an exact literal substring copied from response_text.",
        "If the startup is not mentioned, set startup_mentioned to false and keep mention_count as 0.",
        "Output fields must match these names exactly: startup_mentioned, mention_count, first_mention_position, sentiment, framing, claims, citations.",
        `startup_name: ${startupName}`,
        `ground_truth: ${JSON.stringify(groundTruth, null, 2)}`,
        "response_text:",
        responseText,
    ];

    return promptParts.join("\n\n");
}

export async function parseAIResponse(
    input: unknown,
    deps: ParseAIResponseDeps = {},
): Promise<ParseAIResponseOutput> {
    const parsedInput = parseAIResponseInputSchema.safeParse(input);
    if (!parsedInput.success) {
        return {
            parsed: [],
            errors: [{ response_id: "invalid_input", message: parsedInput.error.message }],
        };
    }

    const model = deps.model ?? createGeminiModel();
    const structuredModel = model.withStructuredOutput(ParsedResponseSchema, {
        name: "response_evidence_extraction",
    });

    const parsed: ParsedResponseEntry[] = [];
    const errors: ParseAIResponseError[] = [];

    for (const response of parsedInput.data.responses) {
        const responseText = response.response_text;
        const startupMentioned = responseText.toLowerCase().includes(parsedInput.data.startup_name.toLowerCase());
        const mentionCount = countOccurrences(responseText, parsedInput.data.startup_name);
        const firstMentionPosition = startupMentioned ? findFirstParagraphPosition(responseText, parsedInput.data.startup_name) : null;

        let result: ParsedResponse | undefined;
        let retryNeeded = false;
        let attemptNumber = 0;

        while (attemptNumber < 2) {
            try {
                const prompt = buildPrompt(
                    parsedInput.data.startup_name,
                    parsedInput.data.ground_truth,
                    response.response_text,
                );
                const raw = await structuredModel.invoke(prompt);
                const normalized = ParsedResponseSchema.safeParse(raw);
                if (!normalized.success) {
                    retryNeeded = true;
                    attemptNumber += 1;
                    continue;
                }

                result = normalized.data;
                break;
            } catch (error) {
                retryNeeded = true;
                attemptNumber += 1;
                if (attemptNumber >= 2) {
                    errors.push({
                        response_id: response.response_id,
                        message: error instanceof Error ? error.message : "Malformed model output",
                    });
                    break;
                }
            }
        }

        if (!result) {
            continue;
        }

        const responseClaimsRaw = Array.isArray(result.claims) ? result.claims : [];
        const cleanedClaims: Array<{
            field: string;
            claim: string;
            polarity?: "supports" | "contradicts" | "neutral";
            matches_ground_truth: "yes" | "no" | "unknown";
            evidence_quote?: string;
            confidence: number;
        }> = responseClaimsRaw.map((claim) => ({
            field: typeof claim.field === "string" && claim.field.length > 0 ? claim.field : "other",
            claim: typeof claim.claim === "string" ? claim.claim : "",
            ...(claim.polarity ? { polarity: claim.polarity } : {}),
            matches_ground_truth: claim.matches_ground_truth ?? "unknown",
            ...(typeof claim.evidence_quote === "string" ? { evidence_quote: claim.evidence_quote } : {}),
            confidence: typeof claim.confidence === "number" ? clamp(claim.confidence) : 0,
        }));

        let invalidEvidenceQuote = false;
        for (const claim of cleanedClaims) {
            if (claim.evidence_quote && !responseText.includes(claim.evidence_quote)) {
                invalidEvidenceQuote = true;
                delete claim.evidence_quote;
            }
        }

        let sentiment = coerceSentiment(result.sentiment);
        if (sentiment === "not_applicable" && typeof result.sentiment === "string" && result.sentiment.trim().length > 0) {
            sentiment = "not_applicable";
        }

        const extractedSentimentWasInvalid = typeof result.sentiment === "string" && !validSentiments.includes(result.sentiment.trim().toLowerCase() as typeof validSentiments[number]);

        const finalStartupMentioned = startupMentioned && result.startup_mentioned !== false;
        const finalMentionCount = finalStartupMentioned ? mentionCount : 0;
        const finalFirstMentionPosition = finalStartupMentioned ? (firstMentionPosition ?? result.first_mention_position ?? null) : null;
        const finalPositionScore = finalStartupMentioned ? calculatePositionScore(finalFirstMentionPosition) : null;

        let confidence = 1;
        if (invalidEvidenceQuote) confidence -= 0.2;
        if (extractedSentimentWasInvalid) confidence -= 0.2;
        const lowConfidenceClaims = cleanedClaims.filter((claim) => claim.confidence < 0.5).length;
        confidence -= lowConfidenceClaims * 0.1;
        if (retryNeeded) confidence -= 0.3;
        confidence = clamp(confidence);

        parsed.push({
            response_id: response.response_id,
            provider: response.provider,
            query_id: response.query_id,
            startup_mentioned: finalStartupMentioned,
            mention_count: finalMentionCount,
            first_mention_position: finalFirstMentionPosition,
            position_score: finalPositionScore,
            sentiment,
            framing: truncateFraming(result.framing),
            claims: cleanedClaims.map((claim) => ({
                field: claim.field,
                claim: claim.claim,
                ...(claim.polarity ? { polarity: claim.polarity } : {}),
                matches_ground_truth: claim.matches_ground_truth,
                ...(claim.evidence_quote ? { evidence_quote: claim.evidence_quote } : {}),
                confidence: claim.confidence,
            })),
            citations: response.citations ?? [],
            parse_confidence: Number(confidence.toFixed(3)),
        });
    }

    return { parsed, errors };
}

export function createParseAIResponseTool(deps: ParseAIResponseDeps = {}) {
    return tool(
        async (input) => parseAIResponse(input, deps),
        {
            name: "parse_ai_response",
            description: "Extract structured startup evidence from raw AI responses and keep per-response parse failures isolated.",
            schema: parseAIResponseInputSchema,
        },
    );
}
