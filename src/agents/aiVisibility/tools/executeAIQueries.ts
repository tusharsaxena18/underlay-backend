// src\agents\aiVisibility\tools\executeAIQueries.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { callGeminiProvider } from "../../../services/gemini";

export const executeAIQueriesInputSchema = z.object({
    run_id: z.string().trim().min(1),
    queries: z.array(z.object({
        query_id: z.string().trim().min(1),
        query: z.string().trim().min(1),
        target_startup: z.string().trim().min(1),
        target_competitor: z.string().trim().optional(),
    })),
    providers: z.array(z.literal("gemini")).min(1),
    tier: z.enum(["1", "2", "3"]),
    max_concurrency: z.number().int().positive().optional(),
    timeout_ms: z.number().int().positive().optional(),
});

export type ExecuteAIQueriesInput = z.infer<typeof executeAIQueriesInputSchema>;

export interface ExecuteAIQueriesDeps {
    geminiProvider?: typeof callGeminiProvider;
}

export interface ExecuteAIQueriesResultEntry {
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
}

export interface ProviderSummary {
    provider: string;
    attempted: number;
    succeeded: number;
    failed: number;
}

export interface ExecuteAIQueriesOutput {
    results: ExecuteAIQueriesResultEntry[];
    provider_summary: ProviderSummary[];
}

function sanitizeToken(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function buildResponseId(runId: string, provider: string, queryId: string): string {
    return `resp_${sanitizeToken(runId)}_${sanitizeToken(provider)}_${sanitizeToken(queryId)}`;
}

async function runGeminiQuery(
    query: string,
    timeoutMs: number,
    providerFn: typeof callGeminiProvider,
): Promise<{ text: string; citations?: string[]; latency_ms: number }> {
    const response = await providerFn(query, { timeoutMs });
    return {
        text: response.text,
        ...(response.citations ? { citations: response.citations } : {}),
        latency_ms: response.latency_ms,
    };
}

export async function executeAIQueries(
    input: unknown,
    deps: ExecuteAIQueriesDeps = {},
): Promise<ExecuteAIQueriesOutput> {
    const parsed = executeAIQueriesInputSchema.safeParse(input);
    if (!parsed.success) {
        return { results: [], provider_summary: [] };
    }

    const values = parsed.data;
    const maxConcurrency = Math.max(1, values.max_concurrency ?? 2);
    const timeoutMs = values.timeout_ms ?? 30000;
    const providerFn = deps.geminiProvider ?? callGeminiProvider;
    const entries: ExecuteAIQueriesResultEntry[] = [];
    const summary = new Map<string, { attempted: number; succeeded: number; failed: number }>();

    for (const provider of values.providers) {
        summary.set(provider, { attempted: 0, succeeded: 0, failed: 0 });
    }

    const tasks: Array<Promise<void>> = [];
    const queue: Array<{ provider: string; query: typeof values.queries[number] }> = [];

    for (const provider of values.providers) {
        for (const query of values.queries) {
            queue.push({ provider, query });
        }
    }

    for (let index = 0; index < queue.length; index += maxConcurrency) {
        const batch = queue.slice(index, index + maxConcurrency);
        tasks.push(
            Promise.all(batch.map(async ({ provider, query }) => {
                const summaryEntry = summary.get(provider)!;
                summaryEntry.attempted += 1;
                const responseId = buildResponseId(values.run_id, provider, query.query_id);
                const baseEntry: ExecuteAIQueriesResultEntry = {
                    response_id: responseId,
                    run_id: values.run_id,
                    query_id: query.query_id,
                    provider,
                    status: "skipped",
                    captured_at: new Date().toISOString(),
                };

                try {
                    if (provider === "gemini") {
                        const result = await runGeminiQuery(query.query, timeoutMs, providerFn);
                        entries.push({
                            ...baseEntry,
                            status: "success",
                            response_text: result.text,
                            ...(result.citations ? { citations: result.citations } : {}),
                            latency_ms: result.latency_ms,
                        });
                        summaryEntry.succeeded += 1;
                        return;
                    }

                    const reason = "provider_not_implemented";
                    entries.push({
                        ...baseEntry,
                        status: "skipped",
                        error_code: reason,
                    });
                    summaryEntry.failed += 1;
                } catch (error) {
                    const message = error instanceof Error ? error.message : "unknown_error";
                    const status = message === "timeout" ? "timeout" : "error";
                    entries.push({
                        ...baseEntry,
                        status,
                        error_code: status === "timeout" ? "timeout" : "provider_failed",
                        ...(status === "error" ? { error_code: "provider_failed" } : {}),
                    });
                    summaryEntry.failed += 1;
                }
            })).then(() => undefined),
        );
    }

    await Promise.all(tasks);

    const providerSummary = Array.from(summary.entries()).map(([provider, stats]) => ({
        provider,
        attempted: stats.attempted,
        succeeded: stats.succeeded,
        failed: stats.failed,
    }));

    return {
        results: entries,
        provider_summary: providerSummary,
    };
}

export function createExecuteAIQueriesTool(deps: ExecuteAIQueriesDeps = {}) {
    return tool(
        async (input) => executeAIQueries(input, deps),
        {
            name: "execute_ai_queries",
            description: "Run the AI visibility query battery against Gemini and retain partial results per query.",
            schema: executeAIQueriesInputSchema,
        },
    );
}
