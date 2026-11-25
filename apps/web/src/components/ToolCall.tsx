import type { FeedItem, FeedToolCall } from "@eien/web/protocol";
import { useState } from "react";

type ToolResult = Extract<FeedItem, { kind: "tool" }>;

function parse(args: string): Record<string, unknown> {
    try {
        const value = JSON.parse(args) as unknown;
        return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** A short label and the one argument that says what the call does. */
export function describeCall(name: string, args: string): { label: string; detail: string } {
    const values = parse(args);
    const pick = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : "");
    switch (name) {
        case "bash": {
            const command = pick("command");
            return { label: command.trimStart().startsWith("agent-browser") ? "browser" : "bash", detail: command };
        }
        case "read":
        case "write":
        case "edit":
        case "send_file":
            return { label: name.replace("_", " "), detail: pick("path") };
        case "web_search":
            return { label: "search", detail: pick("query") };
        case "web_fetch":
            return { label: "fetch", detail: pick("url") };
        case "schedule":
            return { label: "schedule", detail: `${pick("action") || "add"} ${pick("name")}`.trim() };
        case "subagent":
            return { label: "subagent", detail: `${pick("action")} ${pick("name")}`.trim() };
        default:
            return { label: name, detail: args === "{}" ? "" : args };
    }
}

export function ToolCall({ call, result }: { call: FeedToolCall; result?: ToolResult }) {
    const [open, setOpen] = useState(false);
    const { label, detail } = describeCall(call.name, call.args);
    const state = result === undefined ? "running" : result.isError ? "error" : "done";
    return (
        <div className={`tool tool-${state}`}>
            <button type="button" className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
                <span className="tool-mark" aria-hidden="true" />
                <span className="tool-label">{label}</span>
                <span className="tool-detail">{detail}</span>
                <span className="tool-state">{state === "running" ? "…" : state === "error" ? "err" : "ok"}</span>
            </button>
            {open && (
                <div className="tool-body">
                    {call.name !== "bash" && detail !== call.args && <pre className="tool-args">{call.args}</pre>}
                    <pre className="tool-output">{result?.text || (result ? "(no output)" : "still running")}</pre>
                </div>
            )}
        </div>
    );
}

export type { ToolResult };
