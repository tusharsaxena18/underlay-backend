import { AgentTier } from "../types/schema";

interface AIVisibilityInput {
    startup_name: string;
    icp: string;
    problem_statement: string;
    category: string;
    competitors: string[];

    ground_truth: {
        product_description: string;
        pricing_model: string;
        founding_year: number;
        key_differentiators: string[];
        current_stage: string;
    };

    tier: AgentTier;
}

interface RawModelResponse {
    query: string;
    model: string;
    response: string;
    timestamp: Date;
    success: boolean;
}

export type QueryType =
    | "category"
    | "problem"
    | "comparison"
    | "direct";

export interface GeneratedQuery {
    query: string;
    type: QueryType;
}

export interface GeneratedQueries {
    category: GeneratedQuery[];
    problem: GeneratedQuery[];
    comparison: GeneratedQuery[];
    direct: GeneratedQuery[];
}