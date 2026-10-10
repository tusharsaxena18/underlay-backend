// src\agents\aiVisibility\tools\calculateVisibilityScore.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const SCORING_VERSION = "v1";

const BASE_WEIGHTS = {
    mention_rate: 0.25,
    avg_position_score: 0.2,
    accuracy_score: 0.25,
    sentiment_score: 0.15,
    competitive_fairness_score: 0.15,
} as const;

const scoreInputSchema = z.object({
    mention_rate: z.number().nullable(),
    avg_position_score: z.number().nullable(),
    accuracy_score: z.number().nullable(),
    sentiment_score: z.number().nullable(),
    competitive_fairness_score: z.number().nullable(),
    tier: z.enum(["1", "2", "3"]),
});

export type CalculateVisibilityScoreInput = z.infer<typeof scoreInputSchema>;

export interface VisibilityScoreResult {
    component_scores: CalculateVisibilityScoreInput extends infer T
        ? Omit<T, "tier">
        : never;
    weights_used: Record<string, number>;
    composite_visibility_score: number | null;
    coverage: number;
    scoring_version: string;
    limitations: string[];
}

function errorResult(message: string) {
    return { error: { code: "INVALID_INPUT", message } };
}

export function calculateVisibilityScore(
    input: unknown,
): VisibilityScoreResult | ReturnType<typeof errorResult> {
    const parsed = scoreInputSchema.safeParse(input);
    if (!parsed.success) {
        return errorResult(parsed.error.message);
    }

    const { tier, ...scores } = parsed.data;
    const eligibleMetrics = (Object.keys(BASE_WEIGHTS) as Array<
        keyof typeof BASE_WEIGHTS
    >).filter(
        (metric) => metric !== "competitive_fairness_score" || tier === "3",
    );
    const componentScores: VisibilityScoreResult["component_scores"] = {
        ...scores,
        competitive_fairness_score:
            tier === "3" ? scores.competitive_fairness_score : null,
    };
    const limitations: string[] = [];
    const available: Array<keyof typeof BASE_WEIGHTS> = [];

    for (const metric of eligibleMetrics) {
        const value = componentScores[metric];
        if (value === null) {
            limitations.push(`Missing metric: ${metric}`);
            continue;
        }
        const clampedValue = Math.min(1, Math.max(0, value));
        if (clampedValue !== value) {
            limitations.push(`Metric ${metric} was clamped to [0, 1]`);
        }
        componentScores[metric] = clampedValue;
        available.push(metric);
    }

    if (available.length === 0) {
        limitations.push("No metrics available to score");
        return {
            component_scores: componentScores,
            weights_used: {},
            composite_visibility_score: null,
            coverage: 0,
            scoring_version: SCORING_VERSION,
            limitations,
        };
    }

    const availableBaseWeight = available.reduce(
        (sum, metric) => sum + BASE_WEIGHTS[metric],
        0,
    );
    const tierBaseWeight = tier === "3" ? 1 : 0.85;
    const weightsUsed: Record<string, number> = {};
    let composite = 0;

    for (const metric of available) {
        const normalizedWeight = BASE_WEIGHTS[metric] / availableBaseWeight;
        weightsUsed[metric] = normalizedWeight;
        composite += componentScores[metric]! * normalizedWeight;
    }

    return {
        component_scores: componentScores,
        weights_used: weightsUsed,
        composite_visibility_score: composite,
        coverage: availableBaseWeight / tierBaseWeight,
        scoring_version: SCORING_VERSION,
        limitations,
    };
}

export function createCalculateVisibilityScoreTool(
    _deps: Record<string, never> = {},
) {
    return tool(
        (input) => calculateVisibilityScore(input),
        {
            name: "calculate_visibility_score",
            description:
                "Calculate the weighted visibility score after query results have been evaluated.",
            schema: scoreInputSchema,
        },
    );
}
