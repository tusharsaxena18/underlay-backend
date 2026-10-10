// src\types\schema.ts
import { z } from "zod";

export type AgentTier = 1 | 2 | 3;

const tierSchema = z.enum(["1", "2", "3"]);

export const AIVisibilityInputSchema = z.object({
    startup_name: z.string().trim().min(1),
    icp: z.string().trim().min(1),
    problem_statement: z.string().trim().min(1),
    category: z.string().trim().min(1),
    competitors: z.array(z.string().trim().min(1)),
    ground_truth: z.object({
        product_description: z.string().trim().min(1),
        pricing_model: z.string().trim().min(1),
        founding_year: z.number().int().positive(),
        key_differentiators: z.array(z.string().trim().min(1)),
        current_stage: z.string().trim().min(1),
    }),
    tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

export type AIVisibilityInput = z.infer<typeof AIVisibilityInputSchema>;

const componentScoresSchema = z.object({
    mention_rate: z.number().nullable(),
    avg_position_score: z.number().nullable(),
    accuracy_score: z.number().nullable(),
    sentiment_score: z.number().nullable(),
    competitive_fairness_score: z.number().nullable(),
});

const visibilityMetricsSchema = z.object({
    component_scores: componentScoresSchema,
    weights_used: z.record(z.string(), z.number()),
    composite_visibility_score: z.number().nullable(),
    coverage: z.number().min(0).max(1),
    scoring_version: z.string().min(1),
    limitations: z.array(z.string()),
});

export const AIVisibilityOutputSchema = z.object({
    agent_name: z.literal("ai_visibility"),
    status: z.enum(["success", "partial", "failed"]),
    run_id: z.string().min(1),
    startup_name: z.string().min(1),
    tier: tierSchema,
    generated_at: z.iso.datetime(),
    findings: z.object({
        summary: z.string(),
        metrics: visibilityMetricsSchema,
        flags: z.array(z.object({
            code: z.string(),
            severity: z.enum(["info", "warning", "critical"]),
            message: z.string(),
            evidence_ids: z.array(z.string()).optional(),
        })),
        source_trace: z.array(z.unknown()),
        consistency_issues: z.array(z.unknown()),
    }),
    confidence: z.number().min(0).max(1),
    source_type: z.enum(["verified", "unverified", "mixed"]),
    sources_used: z.array(z.string()),
    raw_trace_id: z.string(),
    limitations: z.array(z.string()),
});

export type AIVisibilityOutput = z.infer<typeof AIVisibilityOutputSchema>;