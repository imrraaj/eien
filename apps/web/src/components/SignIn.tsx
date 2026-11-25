import { useState } from "react";
import { api } from "../api.ts";

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
    const [token, setToken] = useState("");
    const [state, setState] = useState<"idle" | "checking" | "wrong" | "blocked">("idle");

    return (
        <main className="signin">
            <div className="signin-mark" aria-hidden="true">
                永遠
            </div>
            <form
                className="signin-card"
                onSubmit={async (event) => {
                    event.preventDefault();
                    setState("checking");
                    const result = await api.login(token.trim());
                    if (result === "ok") onSignedIn();
                    else setState(result);
                }}
            >
                <h1 className="wordmark">eien</h1>
                <p className="signin-lede">An agent that keeps working after you close the tab.</p>
                <label htmlFor="token">Access token</label>
                <input
                    id="token"
                    type="password"
                    autoComplete="current-password"
                    autoFocus
                    value={token}
                    onChange={(event) => {
                        setToken(event.target.value);
                        setState("idle");
                    }}
                />
                {state === "wrong" && <p className="signin-error">That token is not it.</p>}
                {state === "blocked" && (
                    <p className="signin-error">
                        The server refused this address. Add it to WEB_ORIGIN, or reach the app without a proxy that
                        rewrites Host.
                    </p>
                )}
                <button type="submit" disabled={!token.trim() || state === "checking"}>
                    {state === "checking" ? "checking" : "open the log"}
                </button>
            </form>
        </main>
    );
}
