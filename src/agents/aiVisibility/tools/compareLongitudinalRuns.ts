import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { AIVisibilityOutput } from "../../../types/schema";
import { createVisibilityRunRepository } from "../../..//services/persistence/visibilityRunRepository";

const comparisonRunOutputSchema = z.object({
    run_id: z.string().trim().min(1),
    scoring_version: z.string().trim().min(1),
    findings: z.object({
        metrics: z.object({
            component_scores: z.record(z.string(), z.union([z.number(), z.null()])),
            composite_visibility_score: z.number().nullable(),
            coverage: z.number().nullable(),
            scoring_version: z.string().trim().min(1),
            limitations: z.array(z.string()),
        }),
        flags: z.array(z.object({
            code: z.string().trim().min(1),
        })).default([]),
    }).passthrough(),
}).passthrough();

export const compareLongitudinalRunsInputSchema = z.object({
    startup_id: z.string().trim().min(1),
    current_run_id: z.string().trim().min(1),
    current_output: comparisonRunOutputSchema,
    baseline_run_id: z.string().trim().min(1).optional(),
    lookback_runs: z.number().int().min(1).max(5).optional(),
});

export interface CompareLongitudinalRunsDeps {
    repository: {
        getRunById: (runId: string) => Promise<{
            run_id: string;
            scoring_version?: string;
            output?: AIVisibilityOutput;
        } | null>;
        getLatestRunForStartup: (startupId: string) => Promise<{
            run_id: string;
            scoring_version?: string;
            output?: AIVisibilityOutput;
        } | null>;
    };
}

export interface CompareLongitudinalRunsOutput {
    baseline_run_id?: string;
    current_run_id: string;
    metric_deltas: Record<string, number | null>;
    newly_appearing_flags: string[];
    resolved_flags: string[];
    summary_data: Array<{
        metric: string;
        previous_value: number | null;
        current_value: number | null;
        delta: number | null;
    }>;
    limitations?: string[];
}

function flattenMetricValues(metrics: Record<string, unknown>): Record<string, number | null> {
    const values: Record<string, number | null> = {};

    for (const [key, value] of Object.entries(metrics)) {
        if (typeof value === "number") {
            values[key] = value;
        } else if (value && typeof value === "object") {
            for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
                if (typeof nestedValue === "number") {
                    values[`${key}.${nestedKey}`] = nestedValue;
                } else if (nestedValue === null) {
                    values[`${key}.${nestedKey}`] = null;
                }
            }
        }
    }

    return values;
}

export async function compareLongitudinalRuns(
    input: unknown,
    deps: CompareLongitudinalRunsDeps,
): Promise<CompareLongitudinalRunsOutput> {
    const parsed = compareLongitudinalRunsInputSchema.safeParse(input);
    if (!parsed.success) {
        return {
            current_run_id: typeof input === "object" && input !== null && "current_run_id" in input ? String((input as { current_run_id?: unknown }).current_run_id ?? "") : "",
            metric_deltas: {},
            newly_appearing_flags: [],
            resolved_flags: [],
            summary_data: [],
            limitations: [parsed.error.message],
        };
    }

    const values = parsed.data;
    const lookbackRuns = Math.max(1, Math.min(values.lookback_runs ?? 1, 5));

    let baseline = null as { run_id: string; scoring_version?: string; output?: AIVisibilityOutput } | null;

    if (values.baseline_run_id) {
        baseline = await deps.repository.getRunById(values.baseline_run_id);
    } else {
        baseline = await deps.repository.getLatestRunForStartup(values.startup_id);
    }

    if (!baseline || baseline.run_id === values.current_run_id) {
        return {
            current_run_id: values.current_run_id,
            metric_deltas: {},
            newly_appearing_flags: [],
            resolved_flags: [],
            summary_data: [],
        };
    }

    if (baseline.scoring_version !== values.current_output.scoring_version) {
        return {
            baseline_run_id: baseline.run_id,
            current_run_id: values.current_run_id,
            metric_deltas: {},
            newly_appearing_flags: [],
            resolved_flags: [],
            summary_data: [],
            limitations: ["Baseline scoring_version does not match the current run; longitudinal comparison skipped."],
        };
    }

    const baselineOutput = baseline.output ?? null;
    if (!baselineOutput) {
        return {
            baseline_run_id: baseline.run_id,
            current_run_id: values.current_run_id,
            metric_deltas: {},
            newly_appearing_flags: [],
            resolved_flags: [],
            summary_data: [],
        };
    }

    const previousMetrics = flattenMetricValues(baselineOutput.findings.metrics as Record<string, unknown>);
    const currentMetrics = flattenMetricValues(values.current_output.findings.metrics as Record<string, unknown>);
    const metricNames = new Set([...Object.keys(previousMetrics), ...Object.keys(currentMetrics)]);

    const metricDeltas: Record<string, number | null> = {};
    const summaryData: Array<{ metric: string; previous_value: number | null; current_value: number | null; delta: number | null }> = [];

    for (const metric of Array.from(metricNames).sort()) {
        const previousValue = previousMetrics[metric] ?? null;
        const currentValue = currentMetrics[metric] ?? null;
        const delta = previousValue === null || currentValue === null ? null : currentValue - previousValue;

        metricDeltas[metric] = delta;
        summaryData.push({
            metric,
            previous_value: previousValue,
            current_value: currentValue,
            delta,
        });
    }

    const currentFlags = new Set((values.current_output.findings.flags ?? []).map((flag) => flag.code));
    const baselineFlags = new Set((baselineOutput.findings.flags ?? []).map((flag) => flag.code));

    const newlyAppearingFlags = Array.from(currentFlags).filter((code) => !baselineFlags.has(code));
    const resolvedFlags = Array.from(baselineFlags).filter((code) => !currentFlags.has(code));

    return {
        baseline_run_id: baseline.run_id,
        current_run_id: values.current_run_id,
        metric_deltas: metricDeltas,
        newly_appearing_flags: newlyAppearingFlags,
        resolved_flags: resolvedFlags,
        summary_data: summaryData,
    };
}

export function createCompareLongitudinalRunsTool(deps: CompareLongitudinalRunsDeps) {
    return tool(
        async (input) => compareLongitudinalRuns(input, deps),
        {
            name: "compare_longitudinal_runs",
            description: "Compare the current visibility run against the closest earlier matching run for the same startup.",
            schema: compareLongitudinalRunsInputSchema,
        },
    );
}
