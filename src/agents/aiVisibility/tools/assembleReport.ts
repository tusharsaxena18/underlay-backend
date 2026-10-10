// src\agents\aiVisibility\tools\assembleReport.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AIVisibilityOutputSchema } from "../../../types/schema";
import type { AIVisibilityOutput } from "../../../types/schema";
import type { VisibilityScoreResult } from "./calculateVisibilityScore";

const assembleReportInputSchema = z.object({
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
        parse_confidence: z.number(),
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

export type AssembleReportInput = z.infer<typeof assembleReportInputSchema>;

function errorResult(code: string, message: string, details?: unknown) {
    return {
        error: {
            code,
            message,
            ...(details === undefined ? {} : { details }),
        },
    };
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

export function assembleReport(input: unknown): AIVisibilityOutput | ReturnType<typeof errorResult> {
    const parsed = assembleReportInputSchema.safeParse(input);
    if (!parsed.success) {
        return errorResult("INVALID_INPUT", parsed.error.message);
    }

    const values = parsed.data;
    const totalAttempted = values.provider_summary.reduce(
        (total, provider) => total + provider.attempted,
        0,
    );
    const totalSucceeded = values.provider_summary.reduce(
        (total, provider) => total + provider.succeeded,
        0,
    );
    const totalFailed = values.provider_summary.reduce(
        (total, provider) => total + provider.failed,
        0,
    );
    const providerSuccessRate =
        totalAttempted === 0 ? 0 : totalSucceeded / totalAttempted;
    const parseSuccessRate =
        totalSucceeded === 0 ? 0 : values.parsed_results.length / totalSucceeded;
    const groundTruthCompleteness =
        values.ground_truth_completeness ?? 0.8;
    const queryCoverage = values.query_coverage_vs_tier_target ?? 1;
    const confidence = clamp01(
        0.4 * providerSuccessRate +
        0.3 * parseSuccessRate +
        0.2 * groundTruthCompleteness +
        0.1 * queryCoverage,
    );

    const applicableMetrics = Object.entries(values.score_result.component_scores).filter(
        ([metric]) => metric !== "competitive_fairness_score" || values.tier === "3",
    );
    const hasNullMetric = applicableMetrics.some(([, metric]) => metric === null);
    const hasImperfectParse = values.parsed_results.some(
        (result) => result.parse_confidence < 1,
    );
    const status =
        totalSucceeded === 0
            ? "failed"
            : totalFailed > 0 || hasImperfectParse || hasNullMetric
              ? "partial"
              : "success";
    const sourceType =
        confidence >= 0.75 && providerSuccessRate >= 0.9
            ? "verified"
            : confidence < 0.4 || providerSuccessRate < 0.5
              ? "unverified"
              : "mixed";
    const successfulProviders = values.provider_summary.filter(
        (provider) => provider.succeeded >= 1,
    );
    const summary =
        values.summary_override ??
        `${values.startup_name} was mentioned in ${
            values.parsed_results.filter((result) => result.startup_mentioned).length
        }/${values.parsed_results.length} successful responses across ${
            successfulProviders.length
        } provider(s). Composite visibility score: ${
            values.score_result.composite_visibility_score ?? "unavailable"
        }.`;

    const limitations = [
        ...values.score_result.limitations,
        ...(values.limitations_extra ?? []),
    ];
    if (values.ground_truth_completeness === undefined) {
        limitations.push("Default ground_truth_completeness (0.8) was used");
    }
    if (values.query_coverage_vs_tier_target === undefined) {
        limitations.push("Default query_coverage_vs_tier_target (1.0) was used");
    }
    if (totalFailed > 0) {
        limitations.push("One or more provider queries failed");
    }
    if (hasImperfectParse) {
        limitations.push("One or more parsed responses have incomplete confidence");
    }
    for (const [metric, value] of applicableMetrics) {
        if (value === null && !limitations.some((item) => item.includes(metric))) {
            limitations.push(`Missing metric: ${metric}`);
        }
    }

    const output = {
        agent_name: "ai_visibility" as const,
        status,
        run_id: values.run_id,
        startup_name: values.startup_name,
        tier: values.tier,
        generated_at: new Date().toISOString(),
        findings: {
            summary,
            metrics: values.score_result,
            flags: values.flags ?? [],
            source_trace: [],
            consistency_issues: [],
        },
        confidence,
        source_type: sourceType,
        sources_used: successfulProviders.map((provider) => provider.provider),
        raw_trace_id: values.run_id,
        limitations,
    };
    const validated = AIVisibilityOutputSchema.safeParse(output);
    if (!validated.success) {
        return errorResult(
            "OUTPUT_VALIDATION_FAILED",
            "Assembled report did not match AIVisibilityOutputSchema",
            validated.error.issues,
        );
    }
    return validated.data;
}

export function createAssembleReportTool(
    _deps: Record<string, never> = {},
) {
    return tool(
        (input) => assembleReport(input),
        {
            name: "assemble_report",
            description:
                "Assemble provider results and calculated scores into the validated AI visibility report.",
            schema: assembleReportInputSchema,
        },
    );
}
