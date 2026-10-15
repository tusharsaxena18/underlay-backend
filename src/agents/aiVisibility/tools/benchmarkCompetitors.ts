import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AIVisibilityInputSchema } from "../../../types/schema";
import type { ExecuteAIQueriesOutput } from "./executeAIQueries";
import { executeAIQueries } from "./executeAIQueries";
import { parseAIResponse } from "./parseAIResponse";

export const benchmarkCompetitorsInputSchema = z.object({
    run_id: z.string().trim().min(1),
    startup_name: z.string().trim().min(1),
    competitors: z.array(z.string().trim().min(1)),
    query_templates: z.array(z.object({
        query_id: z.string().trim().min(1),
        template: z.string().trim().min(1),
        query_type: z.string().trim().min(1),
    })),
    providers: z.array(z.literal("gemini")).min(1),
    tier: z.enum(["1", "2", "3"]),
    ground_truth: AIVisibilityInputSchema.shape.ground_truth,
    max_competitors: z.number().int().min(1).max(3).optional(),
});

export interface BenchmarkCompetitorsDeps {
    executeAIQueries?: typeof executeAIQueries;
    parseAIResponse?: typeof parseAIResponse;
}

export interface BenchmarkCompetitorResult {
    competitor_name: string;
    queries_attempted: number;
    mention_rate_by_model: Record<string, number>;
    average_position_score: number | null;
    sentiment_score: number | null;
    evidence_response_ids: string[];
}

export interface BenchmarkCompetitorsOutput {
    competitors: BenchmarkCompetitorResult[];
    relative_visibility: Array<{
        competitor_name: string;
        startup_score: number | null;
        competitor_score: number | null;
        delta: number | null;
    }>;
    status: "success" | "partial" | "skipped";
    limitations?: string[];
}

function normalizeCompetitorName(name: string): string {
    return name.trim();
}

function withQueryVariables(template: string, startupName: string, competitorName: string): string {
    return template
        .replace(/\{startup_name\}/gi, startupName)
        .replace(/\{competitor\}/gi, competitorName);
}

function mapSentiment(value: string | undefined): number | null {
    const normalized = (value ?? "").toLowerCase();
    if (normalized === "positive") return 1;
    if (normalized === "neutral") return 0.5;
    if (normalized === "negative") return 0;
    if (normalized === "mixed") return 0.5;
    if (normalized === "not_applicable") return null;
    return null;
}

function aggregateMentionRate(results: Array<{ startup_mentioned: boolean }>): number {
    if (results.length === 0) return 0;
    const mentions = results.filter((row) => row.startup_mentioned).length;
    return mentions / results.length;
}

function aggregateAveragePosition(results: Array<{ position_score: number | null }>): number | null {
    const valid = results
        .map((row) => row.position_score)
        .filter((value): value is number => value !== null && Number.isFinite(value));
    if (valid.length === 0) return null;
    return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function aggregateSentiment(results: Array<{ sentiment: string }>): number | null {
    const mapped = results
        .map((row) => mapSentiment(row.sentiment))
        .filter((value): value is number => value !== null);
    if (mapped.length === 0) return null;
    return mapped.reduce((sum, value) => sum + value, 0) / mapped.length;
}

export async function benchmarkCompetitors(
    input: unknown,
    deps: BenchmarkCompetitorsDeps = {},
): Promise<BenchmarkCompetitorsOutput> {
    const parsed = benchmarkCompetitorsInputSchema.safeParse(input);
    if (!parsed.success) {
        return {
            competitors: [],
            relative_visibility: [],
            status: "skipped",
            limitations: [parsed.error.message],
        };
    }

    const values = parsed.data;
    if (values.tier !== "3") {
        return {
            competitors: [],
            relative_visibility: [],
            status: "skipped",
            limitations: ["benchmark_competitors is only available for Tier 3 runs"],
        };
    }

    const seen = new Set<string>();
    const uniqueCompetitors = values.competitors
        .map((competitor) => normalizeCompetitorName(competitor))
        .filter((competitor) => {
            const slug = competitor.toLowerCase();
            if (seen.has(slug)) return false;
            seen.add(slug);
            return true;
        });

    const limit = Math.min(values.max_competitors ?? 3, 3);
    const competitors = uniqueCompetitors.slice(0, limit);

    if (competitors.length === 0) {
        return {
            competitors: [],
            relative_visibility: [],
            status: "skipped",
            limitations: ["No competitors available for benchmarking"],
        };
    }

    const executeAIQueriesFn = deps.executeAIQueries ?? executeAIQueries;
    const parseAIResponseFn = deps.parseAIResponse ?? parseAIResponse;

    const startupQuerySet = values.query_templates.map((template) => ({
        query_id: template.query_id,
        query: withQueryVariables(template.template, values.startup_name, values.startup_name),
        target_startup: values.startup_name,
    }));

    const startupExecution = await executeAIQueriesFn({
        run_id: values.run_id,
        queries: startupQuerySet,
        providers: values.providers,
        tier: values.tier,
        max_concurrency: 2,
        timeout_ms: 30000,
    });

    const startupResponses = startupExecution.results.filter((result) => result.status === "success");
    const startupParse = await parseAIResponseFn({
        startup_name: values.startup_name,
        ground_truth: values.ground_truth,
        responses: startupResponses.map((result) => ({
            response_id: result.response_id,
            provider: result.provider,
            query_id: result.query_id,
            response_text: result.response_text ?? "",
            citations: result.citations ?? [],
        })),
    });

    const startupParsed = startupParse.parsed ?? [];
    const startupScore = startupParsed.length === 0
        ? null
        : aggregateMentionRate(startupParsed.map((row) => ({ startup_mentioned: row.startup_mentioned })));

    const competitorResults: BenchmarkCompetitorResult[] = [];
    const relativeVisibility: Array<{ competitor_name: string; startup_score: number | null; competitor_score: number | null; delta: number | null; }> = [];
    let status: "success" | "partial" | "skipped" = "success";

    for (const competitor of competitors) {
        const querySet = values.query_templates.map((template) => ({
            query_id: template.query_id,
            query: withQueryVariables(template.template, values.startup_name, competitor),
            target_startup: values.startup_name,
            target_competitor: competitor,
        }));

        const execution = await executeAIQueriesFn({
            run_id: `${values.run_id}_${competitor.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
            queries: querySet,
            providers: values.providers,
            tier: values.tier,
            max_concurrency: 2,
            timeout_ms: 30000,
        });

        const successful = execution.results.filter((result) => result.status === "success");
        const parsed = await parseAIResponseFn({
            startup_name: competitor,
            ground_truth: values.ground_truth,
            responses: successful.map((result) => ({
                response_id: result.response_id,
                provider: result.provider,
                query_id: result.query_id,
                response_text: result.response_text ?? "",
                citations: result.citations ?? [],
            })),
        });

        const parsedRows = parsed.parsed ?? [];
        const providerRates: Record<string, number> = {};
        for (const provider of values.providers) {
            const providerRows = parsedRows.filter((row) => row.provider === provider);
            providerRates[provider] = providerRows.length === 0 ? 0 : aggregateMentionRate(providerRows.map((row) => ({ startup_mentioned: row.startup_mentioned })));
        }

        const competitorScore = parsedRows.length === 0 ? null : aggregateMentionRate(parsedRows.map((row) => ({ startup_mentioned: row.startup_mentioned })));
        const averagePosition = aggregateAveragePosition(parsedRows.map((row) => ({ position_score: row.position_score ?? null })));
        const sentimentScore = aggregateSentiment(parsedRows.map((row) => ({ sentiment: row.sentiment })));

        if (execution.provider_summary.some((provider) => provider.failed > 0) || parsed.errors.length > 0) {
            status = "partial";
        }

        competitorResults.push({
            competitor_name: competitor,
            queries_attempted: querySet.length,
            mention_rate_by_model: providerRates,
            average_position_score: averagePosition,
            sentiment_score: sentimentScore,
            evidence_response_ids: parsedRows.map((row) => row.response_id),
        });

        relativeVisibility.push({
            competitor_name: competitor,
            startup_score: startupScore,
            competitor_score: competitorScore,
            delta: competitorScore === null || startupScore === null ? null : competitorScore - startupScore,
        });
    }

    return {
        competitors: competitorResults,
        relative_visibility: relativeVisibility,
        status,
    };
}

export function createBenchmarkCompetitorsTool(deps: BenchmarkCompetitorsDeps = {}) {
    return tool(
        async (input) => benchmarkCompetitors(input, deps),
        {
            name: "benchmark_competitors",
            description: "Benchmark the startup against a capped set of named competitors under the same provider and query conditions.",
            schema: benchmarkCompetitorsInputSchema,
        },
    );
}
