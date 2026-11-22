import { afterAll, describe, expect, test } from "bun:test";
import { createWebClient } from "../../packages/agent/src/web.ts";

type Rpc = { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

/** Fake Exa MCP endpoint. `reply` decides each tools/call answer; sessions can be expired. */
function fakeMcp(reply: (call: Rpc) => Response | object) {
  const calls: Rpc[] = [];
  let sessions = 0;
  const valid = new Set<string>();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Rpc;
      calls.push(body);
      if (body.method === "initialize") {
        const session = `s${++sessions}`;
        valid.add(session);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} }, { headers: { "mcp-session-id": session } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (!valid.has(request.headers.get("mcp-session-id") ?? "")) return new Response("expired", { status: 404 });
      const answer = reply(body);
      return answer instanceof Response ? answer : Response.json({ jsonrpc: "2.0", id: body.id, result: answer });
    },
  });
  return { server, calls, expireAll: () => valid.clear(), url: `http://localhost:${server.port}/mcp` };
}

const text = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], isError });

describe("web client", () => {
  const mcp = fakeMcp((call) => {
    const args = call.params?.arguments ?? {};
    if (args.query === "boom") return text("rate limited", true);
    if (args.query === "garbage") return { content: "not a list" };
    if (args.query === "sse") {
      const frames = [": keepalive", "data: not json", `data: ${JSON.stringify({ jsonrpc: "2.0", id: call.id, result: text("from sse") })}`];
      return new Response(frames.join("\n"), { headers: { "content-type": "text/event-stream" } });
    }
    return text(`results for ${String(args.query ?? (args.urls as string[])[0])}`);
  });
  const web = createWebClient({ mcpUrl: mcp.url });
  afterAll(() => mcp.server.stop(true));

  test("searches and fetches", async () => {
    expect((await web.search("bun")).unwrap()).toBe("results for bun");
    expect((await web.fetch("https://example.com/x")).unwrap()).toBe("results for https://example.com/x");
  });

  test("reads the matching frame from an SSE response", async () => {
    expect((await web.search("sse")).unwrap()).toBe("from sse");
  });

  test("turns tool errors and malformed results into WebFailed", async () => {
    const failed = await web.search("boom");
    expect(failed.isErr() && failed.error).toMatchObject({ _tag: "WebFailed", message: "rate limited" });
    const garbage = await web.search("garbage");
    expect(garbage.isErr() && garbage.error.message).toBe("MCP returned an invalid result");
  });

  test("rejects bad input before calling out", async () => {
    const before = mcp.calls.length;
    const empty = await web.search("   ");
    const ftp = await web.fetch("ftp://example.com");
    const creds = await web.fetch("https://user:pw@example.com");
    expect([empty, ftp, creds].map((result) => result.isErr() && result.error._tag)).toEqual([
      "InvalidWebInput",
      "InvalidWebInput",
      "InvalidWebInput",
    ]);
    expect(mcp.calls.length).toBe(before);
  });

  test("opens a new session once when the old one expires", async () => {
    mcp.expireAll();
    expect((await web.search("again")).unwrap()).toBe("results for again");
    expect(mcp.calls.filter((call) => call.method === "initialize").length).toBe(2);
  });

  test("reports an unreachable endpoint as WebFailed", async () => {
    const offline = createWebClient({ mcpUrl: "http://127.0.0.1:1/mcp" });
    const result = await offline.search("x");
    expect(result.isErr() && result.error._tag).toBe("WebFailed");
  });
});
