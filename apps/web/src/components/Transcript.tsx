import type { FeedItem } from "@eien/web/protocol";
import { Fragment, useMemo } from "react";
import { fileUrl } from "../api.ts";
import type { Row } from "../conversation.ts";
import { Markdown } from "./Markdown.tsx";
import { ToolCall, type ToolResult } from "./ToolCall.tsx";

const formatBytes = (bytes: number) =>
    bytes < 1024
        ? `${bytes} B`
        : bytes < 1024 ** 2
          ? `${(bytes / 1024).toFixed(1)} KB`
          : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/** Agent notes about attachments are shown as chips, not as text. */
function splitAttachments(text: string): { body: string; files: string[] } {
    const files: string[] = [];
    const body = text
        .replace(/\[attached file saved in the sandbox: \S+ \(([^,]+),[^\]]*\)\]/g, (_, name: string) => {
            files.push(name);
            return "";
        })
        .replace("The user sent this without instructions.", "")
        .trim();
    return { body, files };
}

function Gutter({ id }: { id?: number }) {
    return <span className="gutter">{id === undefined ? "" : String(id).padStart(4, "0")}</span>;
}

function UserItem({ item }: { item: Extract<FeedItem, { kind: "user" }> }) {
    const { body, files } = splitAttachments(item.text);
    // Reports from schedules and subagents arrive as user turns; mark them as the system's.
    const automated = /^\[subagent \S+ (finished|failed)/.test(body);
    return (
        <article className={`row row-user${automated ? " row-automated" : ""}`}>
            <Gutter id={item.id} />
            <div className="bubble">
                {body && <p className="user-text">{body}</p>}
                {files.length > 0 && (
                    <div className="chips">
                        {files.map((name) => (
                            <span key={name} className="chip">
                                {name}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        </article>
    );
}

export function Transcript({ rows }: { rows: readonly Row[] }) {
    const results = useMemo(() => {
        const byCall = new Map<string, ToolResult>();
        for (const row of rows)
            if (row.kind === "item" && row.item.kind === "tool") byCall.set(row.item.callId, row.item);
        return byCall;
    }, [rows]);
    const paired = useMemo(() => {
        const calls = new Set<string>();
        for (const row of rows) {
            if (row.kind === "item" && row.item.kind === "assistant")
                for (const call of row.item.toolCalls) calls.add(call.id);
        }
        return calls;
    }, [rows]);

    return (
        <>
            {rows.map((row) => {
                switch (row.kind) {
                    case "pending":
                        return (
                            <article key={row.key} className="row row-user row-pending">
                                <Gutter />
                                <div className="bubble">
                                    {row.text && <p className="user-text">{row.text}</p>}
                                    {row.files.length > 0 && (
                                        <div className="chips">
                                            {row.files.map((name) => (
                                                <span key={name} className="chip">
                                                    {name}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                    <span className="pending-note">sent, waiting for the agent</span>
                                </div>
                            </article>
                        );
                    case "notice":
                        return (
                            <div key={row.key} className="row row-notice" role="status">
                                <Gutter />
                                <p>{row.text}</p>
                            </div>
                        );
                    case "file":
                        return (
                            <div key={row.key} className="row row-file">
                                <Gutter />
                                <a className="file-card" href={fileUrl(row.file)} download>
                                    <span className="file-name">{row.file.name}</span>
                                    <span className="file-meta">{formatBytes(row.file.size)} · download</span>
                                    {row.file.caption && <span className="file-caption">{row.file.caption}</span>}
                                </a>
                            </div>
                        );
                    case "item": {
                        const item = row.item;
                        switch (item.kind) {
                            case "user":
                                return <UserItem key={item.id} item={item} />;
                            case "assistant":
                                if (!item.text && item.toolCalls.length === 0) return <Fragment key={item.id} />;
                                return (
                                    <article key={item.id} className="row row-assistant">
                                        <Gutter id={item.id} />
                                        <div className="answer">
                                            {item.text && <Markdown text={item.text} />}
                                            {item.toolCalls.map((call) => (
                                                <ToolCall key={call.id} call={call} result={results.get(call.id)} />
                                            ))}
                                        </div>
                                    </article>
                                );
                            case "tool":
                                // Shown with the call that made it; orphans (a call before the loaded history) stand alone.
                                if (paired.has(item.callId)) return <Fragment key={item.id} />;
                                return (
                                    <article key={item.id} className="row row-assistant">
                                        <Gutter id={item.id} />
                                        <div className="answer">
                                            <ToolCall
                                                call={{ id: item.callId, name: item.name, args: "{}" }}
                                                result={item}
                                            />
                                        </div>
                                    </article>
                                );
                            case "reset":
                                return (
                                    <div key={item.id} className="row row-reset">
                                        <span>context cleared</span>
                                    </div>
                                );
                        }
                    }
                }
                return null;
            })}
        </>
    );
}
