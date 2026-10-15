import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AIVisibilityInputSchema } from "../../../types/schema";

export const validateStartupInputInputSchema = AIVisibilityInputSchema;

export interface ValidateStartupInputResult {
    valid: boolean;
    input?: z.infer<typeof AIVisibilityInputSchema>;
    errors: string[];
}

export function validateStartupInput(input: unknown): ValidateStartupInputResult {
    const parsed = AIVisibilityInputSchema.safeParse(input);
    if (!parsed.success) {
        return {
            valid: false,
            errors: parsed.error.issues.map((issue) => issue.message),
        };
    }

    return {
        valid: true,
        input: parsed.data,
        errors: [],
    };
}

export function createValidateStartupInputTool() {
    return tool(
        (input) => validateStartupInput(input),
        {
            name: "validate_startup_input",
            description: "Validate startup visibility input before running the query pipeline.",
            schema: validateStartupInputInputSchema,
        },
    );
}
