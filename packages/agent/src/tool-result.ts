import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Result } from "better-result";

export function toolResult(text: string, isError = false): ToolExecutionResult {
    return { output: [{ type: "text", text }], isError };
}

/**
 * The one place an expected failure becomes something the model reads: a tool error
 * carrying the error's message. Unexpected exceptions still throw, and pi-durable
 * reports them as tool errors on its own.
 */
export function fromResult(result: Result<string, { message: string }>): ToolExecutionResult {
    return result.match({
        ok: (text) => toolResult(text),
        err: (error) => toolResult(error.message, true),
    });
}
