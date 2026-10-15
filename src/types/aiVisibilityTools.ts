// src\types\aiVisibilityTools.ts
import { z } from "zod";

export type QueryTier = "1" | "2" | "3";

export type QueryType =
    | "direct"
    | "category_discovery"
    | "problem_solution"
    | "competitive";

export interface VisibilityQuery {
    query_id: string;
    query: string;
    query_type: QueryType;
    target_startup: string;
    target_competitor?: string;
}

export interface GenerateQueriesOutput {
    queries: VisibilityQuery[];
    count: number;
}

export interface ToolError {
    error: {
        code: string;
        message: string;
        details?: unknown;
    };
}

export interface QueryFamily {
    family: "direct" | "category_discovery" | "problem_solution";
    queryType: Exclude<QueryType, "competitive">;
    templates: readonly string[];
}

export const GenerateQueriesInputSchema = z.object({
    startup_name: z.string().trim().min(1),
    icp: z.string().trim().min(1),
    problem_statement: z.string().trim().min(1),
    category: z.string().trim().min(1),
    competitors: z.array(z.string().trim().min(1)),
    tier: z.enum(["1", "2", "3"]),
    max_queries: z.number().int().nonnegative().optional(),
});

export type GenerateQueriesInput = z.infer<typeof GenerateQueriesInputSchema>;

export const CalculateVisibilityScoreInputSchema = z.object({
    mention_rate: z.number().nullable(),
    avg_position_score: z.number().nullable(),
    accuracy_score: z.number().nullable(),
    sentiment_score: z.number().nullable(),
    competitive_fairness_score: z.number().nullable(),
    tier: z.enum(["1", "2", "3"]),
});

export type CalculateVisibilityScoreInput = z.infer<
    typeof CalculateVisibilityScoreInputSchema
>;

export interface VisibilityScoreResult {
    component_scores: {
        mention_rate: number | null;
        avg_position_score: number | null;
        accuracy_score: number | null;
        sentiment_score: number | null;
        competitive_fairness_score: number | null;
    };
    weights_used: Record<string, number>;
    composite_visibility_score: number | null;
    coverage: number;
    scoring_version: string;
    limitations: string[];
}

export const AssembleReportInputSchema = z.object({
    run_id: z.string().trim().min(1),
    startup_name: z.string().trim().min(1),
    tier: z.enum(["1", "2", "3"]),
    provider_summary: z.array(z.object({
        provider: z.string().trim().min(1),
        attempted: z.number().int().nonnegative(),
        succeeded: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
    })),
    parsed_results: z.array(z.object({
        response_id: z.string().trim().min(1),
        provider: z.string().trim().min(1),
        startup_mentioned: z.boolean(),
        parse_confidence: z.number().min(0).max(1),
    })),
    score_result: z.object({
        component_scores: z.object({
            mention_rate: z.number().nullable(),
            avg_position_score: z.number().nullable(),
            accuracy_score: z.number().nullable(),
            sentiment_score: z.number().nullable(),
            competitive_fairness_score: z.number().nullable(),
        }),
        weights_used: z.record(z.string(), z.number()),
        composite_visibility_score: z.number().nullable(),
        coverage: z.number(),
        scoring_version: z.string(),
        limitations: z.array(z.string()),
    }),
    flags: z.array(z.object({
        code: z.string(),
        severity: z.enum(["info", "warning", "critical"]),
        message: z.string(),
        evidence_ids: z.array(z.string()).optional(),
    })).optional(),
    summary_override: z.string().optional(),
    limitations_extra: z.array(z.string()).optional(),
    ground_truth_completeness: z.number().optional(),
    query_coverage_vs_tier_target: z.number().optional(),
});

export type AssembleReportInput = z.infer<typeof AssembleReportInputSchema>;
