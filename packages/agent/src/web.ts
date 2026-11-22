import { Result, TaggedError } from "better-result";
import { z } from "zod";

export interface WebOptions {
  mcpUrl: string;
  exaApiKey?: string;
}

/** The model asked for something the web tools cannot do (bad URL, empty query). */
export class InvalidWebInput extends TaggedError("InvalidWebInput")<{ message: string }> {}

/** Exa's MCP endpoint failed: network, HTTP status, protocol, or a tool-level error. */
export class WebFailed extends TaggedError("WebFailed")<{ message: string; cause?: unknown }> {}

export type WebError = InvalidWebInput | WebFailed;

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "eien", version: "0.1.0" };
const MAX_RESULT_CHARS = 14_000;

/** JSON-RPC response envelope; extra fields are ignored. */
const RpcResponse = z.looseObject({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ message: z.string().optional(), code: z.number().optional() }).optional(),
});

/** MCP `tools/call` result: text blocks plus an error flag. */
const ToolCallResult = z.looseObject({
  isError: z.boolean().optional(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).default([]),
});

const failed = (message: string, cause?: unknown) => new WebFailed({ message, cause });

function unwrap(message: z.infer<typeof RpcResponse>, id: number): Result<unknown, WebFailed> {
  if (message.id !== undefined && message.id !== id) {
    return Result.err(failed(`MCP response id mismatch (${message.id} != ${id})`));
  }
  if (message.error) {
    const code = message.error.code ? ` ${message.error.code}` : "";
    return Result.err(failed(`MCP error${code}: ${message.error.message ?? "unknown"}`));
  }
  return Result.ok(message.result);
}

/** The JSON-RPC response with `id`, from a JSON body or an SSE stream. */
async function readRpcResponse(response: Response, id: number): Promise<Result<unknown, WebFailed>> {
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    const parsed = RpcResponse.safeParse(await response.json().catch(() => undefined));
    return parsed.success ? unwrap(parsed.data, id) : Result.err(failed("invalid MCP response"));
  }

  for (const line of (await response.text()).split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    // Keepalives and non-JSON frames are skipped.
    const parsed = RpcResponse.safeParse(Result.try(() => JSON.parse(data) as unknown).unwrapOr(undefined));
    if (parsed.success && parsed.data.id === id) return unwrap(parsed.data, id);
  }
  return Result.err(failed(`MCP returned no response for request ${id}`));
}

function toolText(result: unknown): Result<string, WebFailed> {
  const parsed = ToolCallResult.safeParse(result);
  if (!parsed.success) return Result.err(failed("MCP returned an invalid result"));
  const text = parsed.data.content
    .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
    .join("\n\n")
    .trim();
  return parsed.data.isError === true ? Result.err(failed(text || "the web tool reported an error")) : Result.ok(text);
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n… [${text.length - MAX_RESULT_CHARS} characters truncated]`;
}

function httpUrl(value: string): Result<string, InvalidWebInput> {
  const url = Result.try(() => new URL(value)).unwrapOr(undefined);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return Result.err(new InvalidWebInput({ message: "only http(s) URLs are supported" }));
  }
  if (url.username || url.password) {
    return Result.err(new InvalidWebInput({ message: "URLs with credentials are not allowed" }));
  }
  return Result.ok(url.toString());
}

export interface WebClient {
  search(query: string, numResults?: number): Promise<Result<string, WebError>>;
  fetch(url: string): Promise<Result<string, WebError>>;
}

/** web_search and web_fetch through Exa's hosted MCP endpoint, with one lazily opened session. */
export function createWebClient(options: WebOptions): WebClient {
  let session: Promise<Result<string, WebFailed>> | undefined;
  let nextId = 1;

  const headers = (sessionId?: string): Record<string, string> => ({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION } : {}),
    ...(options.exaApiKey ? { "x-api-key": options.exaApiKey } : {}),
  });

  const post = (body: object, sessionId: string | undefined, timeoutMs: number) =>
    Result.tryPromise({
      try: () =>
        fetch(options.mcpUrl, {
          method: "POST",
          headers: headers(sessionId),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      catch: (cause) => failed(`could not reach the web service: ${String(cause)}`, cause),
    });

  const initialize = () =>
    Result.gen(async function* () {
      const id = nextId++;
      const response = yield* Result.await(
        post(
          {
            jsonrpc: "2.0",
            id,
            method: "initialize",
            params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
          },
          undefined,
          30_000,
        ),
      );
      if (!response.ok) {
        yield* failed(`MCP initialize failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
      }
      const sessionId = response.headers.get("mcp-session-id");
      if (!sessionId) return Result.err(failed("MCP server did not return a session id"));
      yield* Result.await(readRpcResponse(response, id));

      // Best-effort protocol notification; Exa accepts requests without it.
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId, 10_000);
      return Result.ok(sessionId);
    });

  /** The open session, opening one if needed. A failed open is forgotten so the next call retries. */
  function sessionId(): Promise<Result<string, WebFailed>> {
    if (!session) {
      const opening = initialize();
      session = opening;
      void opening.then((opened) => {
        if (opened.isErr() && session === opening) session = undefined;
      });
    }
    return session;
  }

  const callTool = (name: string, args: Record<string, unknown>, retry = true): Promise<Result<string, WebFailed>> =>
    Result.gen(async function* () {
      const current = yield* Result.await(sessionId());
      const id = nextId++;
      const response = yield* Result.await(
        post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, current, 45_000),
      );
      if (!response.ok) {
        // An expired session answers 400/404: open a new one and try once more.
        if (retry && (response.status === 400 || response.status === 404)) {
          session = undefined;
          return await callTool(name, args, false);
        }
        yield* failed(`MCP ${name} failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
      }
      const result = yield* Result.await(readRpcResponse(response, id));
      return toolText(result);
    });

  return {
    search(rawQuery, requested = 5) {
      const query = rawQuery.trim();
      if (!query) return Promise.resolve(Result.err(new InvalidWebInput({ message: "query must not be empty" })));
      const numResults = Math.min(10, Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : 5));
      return callTool("web_search_exa", { query, numResults }).then(
        Result.map((text: string) => truncate(text || "(no results)")),
      );
    },

    fetch(rawUrl) {
      return Result.gen(async function* () {
        const url = yield* httpUrl(rawUrl);
        const text = yield* Result.await(callTool("web_fetch_exa", { urls: [url], maxCharacters: 20_000 }));
        return Result.ok(truncate(text || "(empty page)"));
      });
    },
  };
}
