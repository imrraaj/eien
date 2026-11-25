import type { LiveState } from "@eien/web/protocol";
import { describeCall } from "./ToolCall.tsx";
import { Markdown } from "./Markdown.tsx";

const tail = (text: string, lines = 14) => text.split("\n").slice(-lines).join("\n");

/** What the agent is doing right now: the answer as it is written, and tools as they run. */
export function LiveStrip({ live }: { live: LiveState }) {
    const running = live.tools.filter((tool) => tool.status !== "done");
    if (!live.busy && !live.partial) return null;
    return (
        <section className="live" aria-live="polite" aria-label="Agent activity">
            {live.retry && (
                <p className="live-retry">
                    model request failed, retrying at {new Date(live.retry.at).toLocaleTimeString()}: {live.retry.error}
                </p>
            )}
            {running.map((tool) => {
                const { label } = describeCall(tool.name, "{}");
                return (
                    <div key={tool.callId} className="live-tool">
                        <span className="live-tool-head">
                            <span className="pulse" aria-hidden="true" />
                            {label} {tool.status === "pending" ? "queued" : "running"}
                        </span>
                        {tool.output && <pre>{tail(tool.output)}</pre>}
                    </div>
                );
            })}
            {live.partial ? (
                <div className="live-answer">
                    <Markdown text={live.partial} />
                    <span className="caret" aria-hidden="true" />
                </div>
            ) : (
                running.length === 0 && (
                    <p className="live-thinking">
                        <span className="pulse" aria-hidden="true" />
                        thinking
                    </p>
                )
            )}
        </section>
    );
}
