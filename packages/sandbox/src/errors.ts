import { TaggedError } from "better-result";

/** A model-supplied path that is empty, has a NUL byte, or leaves the workspace. */
export class InvalidPath extends TaggedError("InvalidPath")<{ path: string; message: string }> {}

/** A helper command inside the sandbox exited non-zero. */
export class CommandFailed extends TaggedError("CommandFailed")<{
    exitCode: number;
    output: string;
    message: string;
}> {}

/** `editText` refused to edit. */
export class EditFailed extends TaggedError("EditFailed")<{
    path: string;
    reason: "empty" | "not_found" | "ambiguous" | "too_large";
    message: string;
}> {}

/** `CommandFailed` from a non-zero exit, using the command's output as the message when it has one. */
export function commandFailed(exitCode: number, output: string, fallback: string): CommandFailed {
    return new CommandFailed({ exitCode, output, message: output.trim() || `${fallback} (exit ${exitCode})` });
}
