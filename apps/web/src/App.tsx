import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { Composer } from "./components/Composer.tsx";
import { FilesPanel } from "./components/FilesPanel.tsx";
import { LiveStrip } from "./components/LiveStrip.tsx";
import { SignIn } from "./components/SignIn.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { useConversation } from "./conversation.ts";

type Theme = "light" | "dark";

function useTheme(): [Theme, () => void] {
    const [theme, setTheme] = useState<Theme>(
        () =>
            (localStorage.getItem("eien-theme") as Theme | null) ??
            (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    );
    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem("eien-theme", theme);
    }, [theme]);
    return [theme, () => setTheme(theme === "dark" ? "light" : "dark")];
}

function Chat({ onSignedOut }: { onSignedOut: () => void }) {
    const conversation = useConversation(onSignedOut);
    const [theme, toggleTheme] = useTheme();
    const [filesOpen, setFilesOpen] = useState(false);
    const scroller = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);

    // Follow new output while the reader is at the bottom; leave them alone when they scrolled up.
    useLayoutEffect(() => {
        const element = scroller.current;
        if (element && pinned.current) element.scrollTop = element.scrollHeight;
    }, [conversation.rows, conversation.live]);

    const status = !conversation.connected ? "offline" : conversation.live.busy ? "working" : "idle";

    return (
        <div className="app">
            <header className="topbar">
                <div className="brand">
                    <span className="wordmark">eien</span>
                    <span className="brand-kanji" aria-hidden="true">
                        永遠
                    </span>
                </div>
                <span className={`status status-${status}`} role="status">
                    <span className="status-dot" aria-hidden="true" />
                    {status}
                </span>
                <nav className="topbar-actions">
                    <button type="button" onClick={() => setFilesOpen(!filesOpen)} aria-expanded={filesOpen}>
                        files
                    </button>
                    <button
                        type="button"
                        onClick={toggleTheme}
                        aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
                    >
                        {theme === "dark" ? "light" : "dark"}
                    </button>
                    <button
                        type="button"
                        onClick={async () => {
                            await api.logout();
                            onSignedOut();
                        }}
                    >
                        sign out
                    </button>
                </nav>
            </header>

            <div
                className="scroller"
                ref={scroller}
                onScroll={(event) => {
                    const element = event.currentTarget;
                    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                }}
            >
                <main className="log">
                    {conversation.before !== undefined && (
                        <button
                            type="button"
                            className="earlier"
                            onClick={conversation.loadEarlier}
                            disabled={conversation.loading}
                        >
                            {conversation.loading ? "loading" : "earlier entries"}
                        </button>
                    )}
                    {!conversation.loading && conversation.rows.length === 0 && (
                        <div className="empty">
                            <p className="empty-title">Nothing in the log yet.</p>
                            <p>
                                Ask for something real: fix a test, scrape a page, schedule a check. It keeps going if
                                you close this tab.
                            </p>
                        </div>
                    )}
                    <Transcript rows={conversation.rows} />
                    <LiveStrip live={conversation.live} />
                </main>
            </div>

            <footer className="dock">
                <Composer onSend={conversation.send} busy={conversation.live.busy} />
            </footer>

            {filesOpen && <FilesPanel onClose={() => setFilesOpen(false)} />}
        </div>
    );
}

export function App() {
    const [session, setSession] = useState<"unknown" | "in" | "out">("unknown");
    useEffect(() => {
        void api.session().then(
            (ok) => setSession(ok ? "in" : "out"),
            () => setSession("out"),
        );
    }, []);
    const signedOut = useCallback(() => setSession("out"), []);

    if (session === "unknown") return <div className="boot" aria-busy="true" />;
    if (session === "out") return <SignIn onSignedIn={() => setSession("in")} />;
    return <Chat onSignedOut={signedOut} />;
}
