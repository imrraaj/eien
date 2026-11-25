import type { FeedPage, ServerMessage, StoredFile } from "@eien/web/protocol";

export class Unauthorized extends Error {}

async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(path, { credentials: "same-origin", ...init });
    if (response.status === 401) throw new Unauthorized();
    if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `request failed (${response.status})`);
    }
    return response;
}

export const api = {
    async session(): Promise<boolean> {
        return request("/api/session")
            .then(() => true)
            .catch((error: unknown) => {
                if (error instanceof Unauthorized) return false;
                throw error;
            });
    },

    async login(token: string): Promise<"ok" | "wrong" | "blocked"> {
        const response = await fetch("/api/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
        });
        return response.ok ? "ok" : response.status === 403 ? "blocked" : "wrong";
    },

    async logout(): Promise<void> {
        await fetch("/api/logout", { method: "POST" });
    },

    async history(before?: number): Promise<FeedPage> {
        return (await request(`/api/history${before ? `?before=${before}` : ""}`)).json() as Promise<FeedPage>;
    },

    async files(): Promise<StoredFile[]> {
        return (await request("/api/files")).json() as Promise<StoredFile[]>;
    },

    /** Resolves once the server has durably admitted the message. */
    async send(id: string, text: string, files: readonly File[]): Promise<void> {
        const form = new FormData();
        form.set("id", id);
        form.set("text", text);
        for (const file of files) form.append("files", file);
        await request("/api/messages", { method: "POST", body: form });
    },
};

/** `/api/events`, reconnecting with backoff and resuming after the newest item seen. */
export function connectEvents(options: {
    after: () => number;
    onMessage: (message: ServerMessage) => void;
    onState: (state: "open" | "closed") => void;
}): () => void {
    let socket: WebSocket | undefined;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const open = () => {
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        socket = new WebSocket(`${scheme}://${location.host}/api/events?after=${options.after()}`);
        socket.onopen = () => {
            retry = 0;
            options.onState("open");
        };
        socket.onmessage = (event) => options.onMessage(JSON.parse(String(event.data)) as ServerMessage);
        socket.onclose = () => {
            options.onState("closed");
            if (stopped) return;
            timer = setTimeout(open, Math.min(15_000, 500 * 2 ** retry++));
        };
    };

    open();
    return () => {
        stopped = true;
        clearTimeout(timer);
        socket?.close();
    };
}

export const fileUrl = (file: StoredFile) => `/api/files/${file.id}`;
