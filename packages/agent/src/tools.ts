import { defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { editText, readText, writeText, type Sandbox } from "@eien/sandbox";
import type { Result } from "better-result";
import { fromResult, toolResult } from "./tool-result.ts";
import { createWebClient, type WebOptions } from "./web.ts";

const MAX_COMMAND_SECONDS = 900;
const DEFAULT_COMMAND_SECONDS = 120;

/** Hands a sandbox file to whoever owns the conversation; resolves with a note for the model. */
export type DeliverFile = (
    conversationId: ConversationId,
    path: string,
    caption?: string,
) => Promise<Result<string, { message: string }>>;

/** Workspace tools (bash, read, write, edit, send_file) and web tools. */
export function createWorkTools(sandbox: Sandbox, webOptions: WebOptions, deliverFile: DeliverFile) {
    const web = createWebClient(webOptions);

    const bash = defineTool({
        name: "bash",
        description:
            "Run a bash command inside the agent sandbox (not on the host). The working directory is the workspace root.",
        parameters: obj({ command: str(), timeoutSec: opt(num()) }),
        execute: async (args) => {
            const seconds = Math.min(
                MAX_COMMAND_SECONDS,
                Math.max(1, Math.trunc(args.timeoutSec ?? DEFAULT_COMMAND_SECONDS)),
            );
            const run = await sandbox.exec(args.command, { timeoutMs: seconds * 1_000 });
            const suffix = run.timedOut ? `\n(command timed out after ${seconds}s)` : "";
            // A non-zero exit is information for the model, not a tool failure in our sense.
            return toolResult(
                `exit code: ${run.exitCode}\n${run.output.trim() || "(no output)"}${suffix}`,
                run.exitCode !== 0 || run.timedOut,
            );
        },
    });

    const read = defineTool({
        name: "read",
        description: "Read a UTF-8 text file from the sandbox workspace.",
        parameters: obj({ path: str(), offset: opt(num()), limit: opt(num()) }),
        execute: async (args) =>
            fromResult(
                (await readText(sandbox, args.path, { offset: args.offset, limit: args.limit })).map(
                    (file) =>
                        `${file.path} (lines ${file.startLine}-${file.endLine})${file.truncated ? " [truncated]" : ""}\n${file.text || "(empty)"}`,
                ),
            ),
    });

    const write = defineTool({
        name: "write",
        description: "Create or overwrite a UTF-8 text file in the sandbox workspace.",
        parameters: obj({ path: str(), content: str() }),
        execute: async (args) => fromResult(await writeText(sandbox, args.path, args.content)),
    });

    const edit = defineTool({
        name: "edit",
        description: "Replace exactly one occurrence of `old` with `new` in a sandbox file.",
        parameters: obj({ path: str(), old: str(), new: str() }),
        execute: async (args) =>
            fromResult(
                (await editText(sandbox, args.path, args.old, args.new)).map(
                    (edited) => `replaced 1 occurrence at ${edited.path}:${edited.line}`,
                ),
            ),
    });

    const sendFile = defineTool({
        name: "send_file",
        description: "Send a file from the sandbox workspace to the user in the current chat.",
        parameters: obj({ path: str(), caption: opt(str()) }),
        execute: async (args, api) =>
            fromResult(await deliverFile(api.conversationId, args.path, args.caption?.trim() || undefined)),
    });

    const search = defineTool({
        name: "web_search",
        description:
            "Search the web for current information (news, prices, releases, docs). Returns titles, URLs, and snippets; use web_fetch to read a result in full.",
        parameters: obj({ query: str(), numResults: opt(num()) }),
        execute: async (args) => fromResult(await web.search(args.query, args.numResults)),
    });

    const fetchPage = defineTool({
        name: "web_fetch",
        description: "Fetch one http(s) URL and return readable text.",
        parameters: obj({ url: str() }),
        execute: async (args) => fromResult(await web.fetch(args.url)),
    });

    return [bash, read, write, edit, sendFile, search, fetchPage];
}
