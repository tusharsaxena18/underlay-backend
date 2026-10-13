import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AIVisibilityInputSchema, AIVisibilityOutputSchema } from "../../../types/schema";
import type { VisibilityRunDocument, VisibilityRunRepository } from "../../../services/persistence/visibilityRunRepository";

export type PersistVisibilityRunInput = {
    run_id: string;
    startup_id: string;
    started_at: string;
    completed_at: string;
    input_snapshot: z.infer<typeof AIVisibilityInputSchema>;
    raw_response_ids: string[];
    parsed_result_ids: string[];
    output: z.infer<typeof AIVisibilityOutputSchema>;
    scoring_version: string;
    raw_responses: Array<{
        response_id: string;
        run_id: string;
        query_id: string;
        provider: string;
        status: "success" | "error" | "timeout" | "skipped";
        response_text?: string;
        citations?: string[];
        latency_ms?: number;
        error_code?: string;
        captured_at: string;
    }>;
    parsed_results: Array<{
        response_id: string;
        run_id: string;
        query_id: string;
        provider: string;
        startup_mentioned: boolean;
        mention_count: number;
        first_mention_position: number | null;
        position_score: number | null;
        sentiment: string;
        framing: string;
        claims: Array<{
            field?: string;
            claim?: string;
            polarity?: "supports" | "contradicts" | "neutral";
            matches_ground_truth?: "yes" | "no" | "unknown";
            evidence_quote?: string;
            confidence?: number;
        }>;
        citations: string[];
        parse_confidence: number;
    }>;
};

export interface PersistVisibilityRunDeps {
    repository: VisibilityRunRepository;
}

export interface PersistVisibilityRunResult {
    persisted: boolean;
    run_id: string;
    record_id?: string;
    inserted_raw: number;
    inserted_parsed: number;
    error?: string;
}

export function deriveStartupId(startupName: string): string {
    return startupName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

const rawResponseSchema = z.object({
    response_id: z.string().trim().min(1),
    run_id: z.string().trim().min(1),
    query_id: z.string().trim().min(1),
    provider: z.string().trim().min(1),
    status: z.enum(["success", "error", "timeout", "skipped"]),
    response_text: z.string().optional(),
    citations: z.array(z.string()).optional(),
    latency_ms: z.number().int().nonnegative().optional(),
    error_code: z.string().optional(),
    captured_at: z.string().datetime(),
});

const parsedResultSchema = z.object({
    response_id: z.string().trim().min(1),
    run_id: z.string().trim().min(1),
    query_id: z.string().trim().min(1),
    provider: z.string().trim().min(1),
    startup_mentioned: z.boolean(),
    mention_count: z.number().int().nonnegative(),
    first_mention_position: z.number().int().positive().nullable().optional(),
    position_score: z.number().nullable().optional(),
    sentiment: z.string().trim().min(1),
    framing: z.string().optional().default(""),
    claims: z.array(z.object({
        field: z.string().optional().default("other"),
        claim: z.string().optional().default(""),
        polarity: z.enum(["supports", "contradicts", "neutral"]).optional(),
        matches_ground_truth: z.enum(["yes", "no", "unknown"]).optional().default("unknown"),
        evidence_quote: z.string().optional(),
        confidence: z.number().min(0).max(1).optional().default(0),
    })).optional().default([]),
    citations: z.array(z.string()).optional().default([]),
    parse_confidence: z.number().min(0).max(1).optional().default(0),
});

export const persistVisibilityRunInputSchema = z.object({
    run_id: z.string().trim().min(1),
    startup_id: z.string().trim().min(1),
    started_at: z.string().datetime(),
    completed_at: z.string().datetime(),
    input_snapshot: AIVisibilityInputSchema,
    raw_response_ids: z.array(z.string().trim().min(1)),
    parsed_result_ids: z.array(z.string().trim().min(1)),
    output: AIVisibilityOutputSchema,
    scoring_version: z.string().trim().min(1),
    raw_responses: z.array(rawResponseSchema),
    parsed_results: z.array(parsedResultSchema),
});

export async function persistVisibilityRun(
    input: unknown,
    deps: PersistVisibilityRunDeps,
): Promise<PersistVisibilityRunResult> {
    const parsed = persistVisibilityRunInputSchema.safeParse(input);
    if (!parsed.success) {
        return {
            persisted: false,
            run_id: typeof input === "object" && input !== null && "run_id" in input ? String((input as { run_id?: unknown }).run_id ?? "") : "",
            inserted_raw: 0,
            inserted_parsed: 0,
            error: "validation_failed",
        };
    }

    const values = parsed.data;
    const runId = values.run_id;
    let insertedRaw = 0;
    let insertedParsed = 0;

    try {
        const rawInsert = await deps.repository.saveRawResponses(values.raw_responses as typeof values.raw_responses);
        insertedRaw = rawInsert.inserted;
    } catch {
        insertedRaw = 0;
    }

    try {
        const parsedInsert = await deps.repository.saveParsedResults(values.parsed_results as typeof values.parsed_results);
        insertedParsed = parsedInsert.inserted;
    } catch {
        insertedParsed = 0;
    }

    const runDocument: VisibilityRunDocument = {
        run_id: values.run_id,
        startup_id: values.startup_id,
        startup_name: values.input_snapshot.startup_name,
        tier: values.output.tier,
        scoring_version: values.scoring_version,
        started_at: values.started_at,
        completed_at: values.completed_at,
        input_snapshot: values.input_snapshot,
        raw_response_ids: values.raw_response_ids,
        parsed_result_ids: values.parsed_result_ids,
        output: values.output,
        status: values.output.status,
    };

    try {
        const saveResult = await deps.repository.saveRun(runDocument);
        return {
            persisted: true,
            run_id: runId,
            record_id: saveResult.record_id,
            inserted_raw: insertedRaw,
            inserted_parsed: insertedParsed,
        };
    } catch (error) {
        const message = error instanceof Error ? error.name : "repository_error";

        if (message === "DuplicateRunError" || (error as { code?: string })?.code === "duplicate_run") {
            return {
                persisted: false,
                run_id: runId,
                inserted_raw: insertedRaw,
                inserted_parsed: insertedParsed,
                error: "duplicate_run",
            };
        }

        return {
            persisted: false,
            run_id: runId,
            inserted_raw: insertedRaw,
            inserted_parsed: insertedParsed,
            error: "repository_error",
        };
    }
}

export function createPersistVisibilityRunTool(deps: PersistVisibilityRunDeps) {
    return tool(
        async (input) => persistVisibilityRun(input, deps),
        {
            name: "persist_visibility_run",
            description: "Persist the visibility run, raw responses, and parsed results to MongoDB without invoking an LLM.",
            schema: persistVisibilityRunInputSchema,
        },
    );
}
