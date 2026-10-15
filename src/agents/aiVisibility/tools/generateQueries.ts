// src\agents\aiVisibility\tools\generateQueries.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const TIER_QUERY_LIMITS: Record<QueryTier, number> = {
    "1": 3,
    "2": 5,
    "3": 7,
};

const MAX_COMPETITORS = 3;

const directTemplates = [
    "What does {startup_name} do?",
    "Who is {startup_name} for?",
    "What problem does {startup_name} solve?",
    "What is {startup_name}, and what does it offer?",
    "Which customers benefit from {startup_name}?",
    "How does {startup_name} help its customers?",
] as const;

const categoryTemplates = [
    "What are the leading {category} tools for {icp}?",
    "Which {category} products are best for {icp}?",
    "Top {category} solutions for {icp}?",
    "What {category} software should {icp} consider?",
    "Which {category} platforms serve {icp} best?",
    "Recommend {category} tools for {icp}.",
] as const;

const problemTemplates = [
    "What tools help {icp} solve {problem_statement}?",
    "Best software for {icp} dealing with {problem_statement}?",
    "How can {icp} address {problem_statement} with software?",
    "Which tools are designed to help {icp} with {problem_statement}?",
    "What software can {icp} use to overcome {problem_statement}?",
    "Recommend solutions for {icp} facing {problem_statement}.",
] as const;

const competitiveTemplates = [
    "Compare {startup_name} vs {competitor} for {icp}",
    "Is {startup_name} better than {competitor} for {icp}?",
    "How does {startup_name} compare with {competitor} for {icp}?",
    "Should {icp} choose {startup_name} or {competitor}?",
    "What are the differences between {startup_name} and {competitor} for {icp}?",
    "Which is a better fit for {icp}: {startup_name} or {competitor}?",
] as const;

const queryTierSchema = z.enum(["1", "2", "3"]);

export const GenerateQueriesInputSchema = z.object({
    startup_name: z.string().trim().min(1),
    icp: z.string().trim().min(1),
    problem_statement: z.string().trim().min(1),
    category: z.string().trim().min(1),
    competitors: z.array(z.string().trim().min(1)),
    tier: queryTierSchema,
    max_queries: z.number().int().nonnegative().optional(),
});

export type QueryTier = z.infer<typeof queryTierSchema>;
export type GenerateQueriesInput = z.infer<typeof GenerateQueriesInputSchema>;

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
    };
}

type QueryFamily = {
    family: "direct" | "category_discovery" | "problem_solution";
    queryType: Exclude<QueryType, "competitive">;
    templates: readonly string[];
};

function normalize(value: string): string {
    return value.trim().replace(/\s+/g, " ");
}

export function competitorSlug(name: string): string {
    return normalize(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function interpolate(template: string, values: Record<string, string>): string {
    return template.replace(/\{([a-z_]+)\}/g, (_match, key: string) =>
        normalize(values[key] ?? ""),
    );
}

function errorResult(code: string, message: string): ToolError {
    return { error: { code, message } };
}

export function generateQueries(input: unknown): GenerateQueriesOutput | ToolError {
    const parsed = GenerateQueriesInputSchema.safeParse(input);
    if (!parsed.success) {
        return errorResult("INVALID_INPUT", parsed.error.message);
    }

    const values = parsed.data;
    const tierLimit = TIER_QUERY_LIMITS[values.tier];
    const startupLimit =
        values.max_queries === undefined
            ? tierLimit
            : Math.min(values.max_queries, tierLimit);
    const families: QueryFamily[] = [
        { family: "direct", queryType: "direct", templates: directTemplates },
        {
            family: "category_discovery",
            queryType: "category_discovery",
            templates: categoryTemplates,
        },
    ];

    if (values.tier !== "1") {
        families.push({
            family: "problem_solution",
            queryType: "problem_solution",
            templates: problemTemplates,
        });
    }

    const queries: VisibilityQuery[] = [];
    const familyIndices = families.map(() => 0);

    while (queries.length < startupLimit) {
        let addedInPass = false;
        for (let familyIndex = 0; familyIndex < families.length; familyIndex += 1) {
            if (queries.length >= startupLimit) {
                break;
            }

            const family = families[familyIndex];
            const templateIndex = familyIndices[familyIndex];
            if (family === undefined || templateIndex === undefined) {
                continue;
            }
            const template = family.templates[templateIndex];
            if (template === undefined) {
                continue;
            }

            familyIndices[familyIndex] = templateIndex + 1;
            addedInPass = true;
            queries.push({
                query_id: `q_${family.family}_${templateIndex + 1}`,
                query: interpolate(template, {
                    startup_name: values.startup_name,
                    icp: values.icp,
                    problem_statement: values.problem_statement,
                    category: values.category,
                }),
                query_type: family.queryType,
                target_startup: normalize(values.startup_name),
            });
        }

        if (!addedInPass) {
            break;
        }
    }

    if (values.tier === "3") {
        const seenCompetitors = new Set<string>();
        const competitors = values.competitors.filter((competitor) => {
            const slug = competitorSlug(competitor);
            if (slug.length === 0 || seenCompetitors.has(slug)) {
                return false;
            }
            seenCompetitors.add(slug);
            return true;
        }).slice(0, MAX_COMPETITORS);

        for (const competitor of competitors) {
            const slug = competitorSlug(competitor);
            for (let index = 0; index < 2; index += 1) {
                const template = competitiveTemplates[index];
                if (template === undefined) {
                    continue;
                }
                queries.push({
                    query_id: `q_competitive_${slug}_${index + 1}`,
                    query: interpolate(template, {
                        startup_name: values.startup_name,
                        competitor,
                        icp: values.icp,
                    }),
                    query_type: "competitive",
                    target_startup: normalize(values.startup_name),
                    target_competitor: normalize(competitor),
                });
            }
        }
    }

    return { queries, count: queries.length };
}

export function createGenerateQueriesTool(
    _deps: Record<string, never> = {},
) {
    return tool(
        (input) => generateQueries(input),
        {
            name: "generate_queries",
            description:
                "Generate deterministic startup-discovery and competitor queries for the requested tier.",
            schema: GenerateQueriesInputSchema,
        },
    );
}
