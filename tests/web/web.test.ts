import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationFeed, FeedEvent, FeedPage, InboundEvent } from "../../packages/io/src/index.ts";
import { createLogger } from "../../packages/shared/src/index.ts";
import { createWebService, type ServerMessage, type WebService } from "../../packages/web/src/index.ts";
import type { StoredFile } from "../../packages/web/src/files.ts";

const TOKEN = "test-token-0123456789abcdef";

describe("web service", () => {
    let dir: string;
    let web: WebService;
    let base: string;
    let cookie = "";
    const inbound: InboundEvent[] = [];
    const subscriptions: Array<{ chat: string; after: number }> = [];

    const feed: ConversationFeed = {
        history: async (from, options) => ({
            items: [
                {
                    kind: "user",
                    id: 1,
                    text: `history for ${from.service}:${from.chat} before ${options?.before ?? "none"}`,
                },
            ],
        }),
        subscribe: async (from, after, listener) => {
            subscriptions.push({ chat: `${from.service}:${from.chat}`, after });
            listener({ kind: "live", live: { busy: false, tools: [] } } satisfies FeedEvent);
            return async () => undefined;
        },
    };

    const call = (path: string, init: RequestInit = {}) =>
        fetch(`${base}${path}`, { ...init, headers: { cookie, ...(init.headers as Record<string, string>) } });

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), "eien-web-"));
        await mkdir(join(dir, "app", "assets"), { recursive: true });
        await writeFile(join(dir, "app", "index.html"), "<html>shell</html>");
        await writeFile(join(dir, "app", "assets", "app-abc.js"), "console.log(1)");
        await writeFile(join(dir, "secret.txt"), "do not serve");
        web = createWebService({
            token: TOKEN,
            host: "127.0.0.1",
            port: 0,
            feed,
            filesDir: join(dir, "files"),
            staticDir: join(dir, "app"),
            log: createLogger({ level: "error" }),
        });
        await web.start(async (event) => void inbound.push(event));
        base = web.url()!.replace(/\/$/, "");
    });

    afterAll(async () => {
        await web.stop();
        await rm(dir, { recursive: true, force: true });
    });

    test("requires a session", async () => {
        expect((await fetch(`${base}/api/history`)).status).toBe(401);
        expect((await fetch(`${base}/api/session`)).status).toBe(401);
    });

    test("rejects a wrong token and accepts the right one with a derived cookie", async () => {
        const wrong = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ token: "nope" }) });
        expect(wrong.status).toBe(401);

        const right = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ token: TOKEN }) });
        expect(right.status).toBe(204);
        const setCookie = right.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("SameSite=Strict");
        expect(setCookie).not.toContain(TOKEN);
        cookie = setCookie.split(";")[0]!;
        expect((await call("/api/session")).status).toBe(200);
    });

    test("serves history for the shared chat", async () => {
        const page = (await (await call("/api/history?before=9")).json()) as FeedPage;
        expect(page.items[0]).toMatchObject({ text: "history for web:main before 9" });
    });

    test("refuses state changes from another origin", async () => {
        const response = await call("/api/messages", {
            method: "POST",
            headers: { origin: "https://evil.example" },
            body: new FormData(),
        });
        expect(response.status).toBe(403);
    });

    test("turns a post into a message with attachments, or a command", async () => {
        const form = new FormData();
        form.set("id", "client-message-1");
        form.set("text", "look at this");
        form.append("files", new File(["hello"], "../notes.txt", { type: "text/plain" }));
        expect((await call("/api/messages", { method: "POST", body: form })).status).toBe(202);

        const message = inbound.at(-1)!;
        if (message.kind !== "message") throw new Error("expected a message");
        expect(message).toMatchObject({ from: { service: "web", chat: "main" }, id: "web:client-message-1" });
        expect(message.attachments[0]).toMatchObject({ name: "notes.txt", mime: "text/plain", size: 5 });
        expect(await readFile(message.attachments[0]!.localPath, "utf8")).toBe("hello");

        const command = new FormData();
        command.set("id", "client-message-2");
        command.set("text", "/unschedule joke");
        await call("/api/messages", { method: "POST", body: command });
        expect(inbound.at(-1)).toMatchObject({ kind: "command", name: "unschedule", args: ["joke"] });
    });

    test("rejects malformed posts", async () => {
        const noId = new FormData();
        noId.set("text", "hi");
        expect((await call("/api/messages", { method: "POST", body: noId })).status).toBe(400);
        const blank = new FormData();
        blank.set("id", "client-message-3");
        expect((await call("/api/messages", { method: "POST", body: blank })).status).toBe(400);
    });

    test("streams the feed, notices, statuses, and files over the socket", async () => {
        const socket = new WebSocket(`${base.replace("http", "ws")}/api/events?after=4`, {
            headers: { cookie },
        } as never);
        const received: ServerMessage[] = [];
        socket.onmessage = (event) => received.push(JSON.parse(String(event.data)));
        await new Promise((resolve) => (socket.onopen = resolve));
        while (received.length === 0) await Bun.sleep(5);
        expect(subscriptions.at(-1)).toEqual({ chat: "web:main", after: 4 });
        expect(received[0]).toEqual({ type: "feed", event: { kind: "live", live: { busy: false, tools: [] } } });

        await web.send("main", { kind: "text", text: "answer already in transcript", entry: 12 });
        await web.send("main", { kind: "text", text: "That run failed (x)." });
        await web.send("main", { kind: "status", status: "working" });
        const local = join(dir, "report.txt");
        await writeFile(local, "report body");
        (
            await web.send("main", { kind: "file", localPath: local, name: "report.txt", size: 11, caption: "done" })
        ).unwrap();
        while (received.length < 4) await Bun.sleep(5);
        socket.close();

        expect(received.slice(1).map((message) => message.type)).toEqual(["notice", "status", "file"]);
        const file = received[3]!;
        if (file.type !== "file") throw new Error("expected a file");

        const listed = (await (await call("/api/files")).json()) as StoredFile[];
        expect(listed[0]).toMatchObject({ id: file.file.id, name: "report.txt", caption: "done" });
        const download = await call(`/api/files/${file.file.id}`);
        expect(download.headers.get("content-disposition")).toContain("report.txt");
        expect(await download.text()).toBe("report body");
        expect((await call("/api/files/..%2F..%2Fsecret.txt")).status).toBe(404);
        expect((await call("/api/files/not-a-file-id")).status).toBe(404);
    });

    test("reports files over its limit as DeliveryFailed", async () => {
        const sent = await web.send("main", {
            kind: "file",
            localPath: "/nonexistent",
            name: "big",
            size: 200 * 1024 * 1024,
        });
        expect(sent.isErr() && sent.error.reason).toBe("too_large");
    });

    test("serves the app shell, its assets, and nothing outside it", async () => {
        expect(await (await fetch(`${base}/`)).text()).toBe("<html>shell</html>");
        expect(await (await fetch(`${base}/some/client/route`)).text()).toBe("<html>shell</html>");
        const asset = await fetch(`${base}/assets/app-abc.js`);
        expect(asset.headers.get("cache-control")).toContain("immutable");
        expect(await (await fetch(`${base}/../secret.txt`)).text()).toBe("<html>shell</html>");
        expect((await fetch(`${base}/`)).headers.get("content-security-policy")).toContain("default-src 'self'");
    });
});
