import {
    DeliveryFailed,
    type Address,
    type Attachment,
    type ConversationFeed,
    type InboundSink,
    type InputService,
    type OutboundMessage,
    type OutputService,
} from "@eien/io";
import { formatBytes, type Logger } from "@eien/shared";
import { Result } from "better-result";
import type { Server, ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { authenticated, loginCookie, logoutCookie, sameOrigin, tokenMatches } from "./auth.ts";
import { FileStore } from "./files.ts";
import type { ServerMessage } from "./protocol.ts";

export type { ServerMessage } from "./protocol.ts";

/** The one identity a shared access token stands for. */
export const WEB_ADDRESS: Address = { service: "web", chat: "main" };

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 10;
const MAX_SEND_BYTES = 100 * 1024 * 1024;
const FAILED_LOGIN_DELAY_MS = 750;

const PROMPT_HINT = [
    "You are chatting in the eien web app. Your Markdown renders fully: headings, lists, tables, and fenced code blocks with syntax highlighting.",
    "The user sees your tool calls and their output live, so do not narrate them.",
    `send_file delivers files up to ${formatBytes(MAX_SEND_BYTES)} as downloads.`,
].join(" ");

export interface WebServiceOptions {
    /** Shared access token; everyone who has it is the same user. */
    token: string;
    host: string;
    port: number;
    feed: ConversationFeed;
    /** Where sent files are kept for download. */
    filesDir: string;
    /** Built React app; a placeholder page is served when it is missing. */
    staticDir: string;
    /** Public origins the app is served from (`https://eien.example.com`); needed behind a proxy that rewrites Host. */
    origins?: readonly string[];
    log: Logger;
}

export type WebService = InputService & OutputService & { readonly url: () => string | undefined };

/** Per-socket state: where its feed starts, and how to stop the subscription. */
type SocketData = { after: number; stop?: () => Promise<void> };
type Socket = ServerWebSocket<SocketData>;

const SECURITY_HEADERS = {
    "content-security-policy":
        "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
};

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
const empty = (status: number, headers: Record<string, string> = {}) =>
    new Response(null, { status, headers: { ...SECURITY_HEADERS, ...headers } });

/** Turn the posted text into a command (`/reset`) or a message. */
function inboundText(text: string): { command: string; args: string[] } | undefined {
    if (!text.startsWith("/")) return undefined;
    const [head = "", ...args] = text.split(/\s+/);
    return { command: head.slice(1).toLowerCase(), args };
}

export function createWebService(options: WebServiceOptions): WebService {
    const { token, feed, log } = options;
    const files = new FileStore(options.filesDir);
    const sockets = new Set<Socket>();
    let sink: InboundSink | undefined;
    let server: Server<SocketData> | undefined;

    function allowedOrigin(request: Request): boolean {
        if (sameOrigin(request, options.origins)) return true;
        log.warn("blocked a request from another origin; set WEB_ORIGIN if a proxy rewrites Host", {
            origin: request.headers.get("origin"),
            host: request.headers.get("host"),
        });
        return false;
    }

    function broadcast(message: ServerMessage): void {
        const text = JSON.stringify(message);
        for (const socket of sockets) socket.send(text);
    }

    async function postMessage(request: Request): Promise<Response> {
        const form = await request.formData().catch(() => undefined);
        if (!form) return json({ error: "expected multipart form data" }, 400);
        const id = String(form.get("id") ?? "");
        const text = String(form.get("text") ?? "").trim();
        if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return json({ error: "a message needs a client id" }, 400);

        const uploads = form.getAll("files").flatMap((value) => (typeof value === "string" ? [] : [value]));
        if (uploads.length > MAX_FILES_PER_MESSAGE)
            return json({ error: `at most ${MAX_FILES_PER_MESSAGE} files` }, 400);
        const tooLarge = uploads.find((file) => file.size > MAX_UPLOAD_BYTES);
        if (tooLarge) return json({ error: `${tooLarge.name} is over ${formatBytes(MAX_UPLOAD_BYTES)}` }, 413);

        const from = WEB_ADDRESS;
        const eventId = `web:${id}`;
        const command = uploads.length === 0 ? inboundText(text) : undefined;
        if (command) {
            await sink?.({ kind: "command", from, id: eventId, name: command.command, args: command.args });
            return empty(202);
        }
        if (!text && uploads.length === 0) return json({ error: "empty message" }, 400);

        const attachments: Attachment[] = [];
        for (const file of uploads) {
            const name =
                file.name
                    .replace(/[^A-Za-z0-9._-]+/g, "_")
                    .replace(/^[._]+/, "")
                    .slice(0, 120) || "file";
            const localPath = join(tmpdir(), `eien-web-${randomUUID()}-${name}`);
            await Bun.write(localPath, file);
            attachments.push({
                localPath,
                name,
                mime: file.type.split(";")[0] || "application/octet-stream",
                size: file.size,
            });
        }
        await sink?.({ kind: "message", from, id: eventId, text, attachments });
        return empty(202);
    }

    async function download(id: string): Promise<Response> {
        const found = await files.find(id);
        if (!found) return empty(404);
        return new Response(Bun.file(found.path), {
            headers: {
                ...SECURITY_HEADERS,
                "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(found.file.name)}`,
                "content-type": "application/octet-stream",
            },
        });
    }

    function staticFile(pathname: string): Response {
        const root = options.staticDir;
        const shell = join(root, "index.html");
        if (!isFile(shell)) {
            return new Response("The web app is not built yet. Run `bun run web:build`.", {
                status: 503,
                headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
            });
        }
        // `normalize` resolves `..` against the leading slash, so the result stays under `root`.
        const candidate = join(root, normalize(pathname));
        const asset = candidate.startsWith(`${root}/`) && isFile(candidate);
        // Unknown paths get the app shell (client-side routing); hashed assets cache forever.
        return new Response(Bun.file(asset ? candidate : shell), {
            headers: {
                ...SECURITY_HEADERS,
                "cache-control":
                    asset && pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
            },
        });
    }

    async function route(request: Request, srv: Server<SocketData>): Promise<Response | undefined> {
        const url = new URL(request.url);
        const path = url.pathname;
        if (!path.startsWith("/api/")) return request.method === "GET" ? staticFile(path) : empty(405);
        if (request.method !== "GET" && !allowedOrigin(request)) return empty(403);

        if (path === "/api/login" && request.method === "POST") {
            const body = (await request.json().catch(() => ({}))) as { token?: unknown };
            if (typeof body.token === "string" && tokenMatches(body.token, token)) {
                return empty(204, { "set-cookie": loginCookie(request, token) });
            }
            await Bun.sleep(FAILED_LOGIN_DELAY_MS);
            return json({ error: "wrong token" }, 401);
        }
        if (path === "/api/logout" && request.method === "POST") return empty(204, { "set-cookie": logoutCookie() });
        if (!authenticated(request, token)) return json({ error: "sign in first" }, 401);

        if (path === "/api/session" && request.method === "GET") return json({ ok: true });
        if (path === "/api/history" && request.method === "GET") {
            const before = Number(url.searchParams.get("before"));
            return json(await feed.history(WEB_ADDRESS, Number.isInteger(before) && before > 0 ? { before } : {}));
        }
        if (path === "/api/messages" && request.method === "POST") return postMessage(request);
        if (path === "/api/files" && request.method === "GET") return json(await files.list());
        if (path.startsWith("/api/files/") && request.method === "GET")
            return download(path.slice("/api/files/".length));
        if (path === "/api/events" && request.method === "GET") {
            if (!allowedOrigin(request)) return empty(403);
            const after = Number(url.searchParams.get("after"));
            const upgraded = srv.upgrade(request, {
                data: { after: Number.isInteger(after) && after > 0 ? after : 0 },
            });
            return upgraded ? undefined : json({ error: "expected a WebSocket upgrade" }, 400);
        }
        return empty(404);
    }

    return {
        name: "web",
        promptHint: PROMPT_HINT,
        url: () => server?.url.toString(),

        async start(next) {
            sink = next;
            server = Bun.serve<SocketData>({
                hostname: options.host,
                port: options.port,
                maxRequestBodySize: MAX_FILES_PER_MESSAGE * MAX_UPLOAD_BYTES + 1024 * 1024,
                fetch: (request, srv) =>
                    route(request, srv).catch((error: unknown) => {
                        log.error("web request failed", { path: new URL(request.url).pathname, error });
                        return json({ error: "internal error" }, 500);
                    }),
                websocket: {
                    async open(socket) {
                        sockets.add(socket);
                        socket.data.stop = await feed.subscribe(WEB_ADDRESS, socket.data.after, (event) =>
                            socket.send(JSON.stringify({ type: "feed", event } satisfies ServerMessage)),
                        );
                    },
                    async close(socket) {
                        sockets.delete(socket);
                        await socket.data.stop?.();
                    },
                    message() {
                        // Clients send over HTTP; the socket is server-to-client only.
                    },
                },
            });
            log.info("web app listening", { url: server.url.toString() });
        },

        async stop() {
            for (const socket of sockets) socket.close(1001, "server stopping");
            await Promise.all([...sockets].map((socket) => socket.data.stop?.()));
            sockets.clear();
            await server?.stop(true);
            server = undefined;
        },

        async send(_chat: string, message: OutboundMessage) {
            switch (message.kind) {
                case "text":
                    // Answers are already in the transcript the app shows; only notices need pushing.
                    if (message.entry === undefined) broadcast({ type: "notice", text: message.text, at: Date.now() });
                    return Result.ok(undefined);
                case "status":
                    broadcast({ type: "status", status: message.status });
                    return Result.ok(undefined);
                case "choices":
                    // The web app has no inline keyboard; model switching stays on Telegram.
                    return Result.ok(undefined);
                case "file": {
                    if (message.size > MAX_SEND_BYTES) {
                        return Result.err(
                            new DeliveryFailed({
                                service: "web",
                                reason: "too_large",
                                message: `file is ${formatBytes(message.size)}; the web app takes at most ${formatBytes(MAX_SEND_BYTES)}`,
                            }),
                        );
                    }
                    return Result.tryPromise({
                        try: async () => {
                            const file = await files.add(
                                message.localPath,
                                message.name,
                                message.size,
                                message.caption,
                            );
                            broadcast({ type: "file", file });
                        },
                        catch: (cause) =>
                            new DeliveryFailed({
                                service: "web",
                                reason: "failed",
                                message: `could not store the file: ${String(cause)}`,
                                cause,
                            }),
                    });
                }
            }
        },
    };
}
