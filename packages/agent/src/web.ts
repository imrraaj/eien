import { z } from "zod";

export interface WebOptions {
  mcpUrl: string;
  exaApiKey?: string;
}

export interface WebToolResult {
  text: string;
  isError: boolean;
}

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_NAME = "eien";
const CLIENT_VERSION = "0.1.0";
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

interface McpSession {
  id: string;
}

let session: McpSession | undefined;
let initializing: Promise<McpSession> | undefined;
let nextId = 1;

function requestHeaders(options: WebOptions, sessionId?: string, withBody = false): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
  };
  if (withBody) headers["content-type"] = "application/json";
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
    headers["mcp-protocol-version"] = PROTOCOL_VERSION;
  }
  if (options.exaApiKey) headers["x-api-key"] = options.exaApiKey;
  return headers;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function unwrap(message: unknown, id: number): unknown {
  const parsed = RpcResponse.safeParse(message);
  if (!parsed.success) throw new Error("invalid MCP response");
  const envelope = parsed.data;
  if (envelope.id !== undefined && envelope.id !== id) {
    throw new Error(`MCP response id mismatch (${envelope.id} != ${id})`);
  }
  if (envelope.error) {
    throw new Error(
      `MCP error${envelope.error.code ? ` ${envelope.error.code}` : ""}: ${envelope.error.message ?? "unknown"}`,
    );
  }
  return envelope.result;
}

async function parseRpcResponse(response: Response, id: number): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return unwrap(await response.json(), id);
  }

  const body = await response.text();
  const events = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((data) => data.length > 0 && data !== "[DONE]");

  for (const event of events) {
    try {
      const message = RpcResponse.safeParse(JSON.parse(event));
      if (message.success && message.data.id === id) return unwrap(message.data, id);
    } catch {
      // Ignore keepalive/non-JSON frames.
    }
  }

  throw new Error(`MCP returned no response for request ${id}`);
}

async function initialize(options: WebOptions, signal?: AbortSignal): Promise<McpSession> {
  const id = nextId++;
  const response = await fetch(options.mcpUrl, {
    method: "POST",
    headers: requestHeaders(options, undefined, true),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
    }),
    signal: withTimeout(signal, 30_000),
  });

  if (!response.ok) {
    throw new Error(
      `MCP initialize failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
  }

  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("MCP server did not return a session id");

  await parseRpcResponse(response, id);

  // Best-effort protocol notification; Exa accepts requests without it.
  try {
    await fetch(options.mcpUrl, {
      method: "POST",
      headers: requestHeaders(options, sessionId, true),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: withTimeout(signal, 10_000),
    });
  } catch {
    // Ignore.
  }

  return { id: sessionId };
}

async function getSession(options: WebOptions, signal?: AbortSignal): Promise<McpSession> {
  if (session) return session;
  if (!initializing) {
    initializing = initialize(options, signal)
      .then((created) => {
        session = created;
        return created;
      })
      .finally(() => {
        initializing = undefined;
      });
  }
  return initializing;
}

async function callTool(
  options: WebOptions,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  retry = true,
): Promise<unknown> {
  const current = await getSession(options, signal);
  const id = nextId++;

  const response = await fetch(options.mcpUrl, {
    method: "POST",
    headers: requestHeaders(options, current.id, true),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: withTimeout(signal, 45_000),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    if (retry && (response.status === 400 || response.status === 404)) {
      session = undefined;
      return callTool(options, name, args, signal, false);
    }
    throw new Error(`MCP ${name} failed (HTTP ${response.status}): ${detail}`);
  }

  return parseRpcResponse(response, id);
}

function resultText(result: unknown): { text: string; isError: boolean } {
  const parsed = ToolCallResult.safeParse(result);
  if (!parsed.success) return { text: "MCP returned an invalid result", isError: true };

  const text = parsed.data.content
    .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
    .join("\n\n")
    .trim();
  return { text, isError: parsed.data.isError === true };
}

function truncate(text: string, limit = MAX_RESULT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n… [${text.length - limit} characters truncated]`;
}

function parseHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http(s) URLs are supported");
  }
  if (url.username || url.password) {
    throw new Error("URLs with credentials are not allowed");
  }
  return url;
}

async function guarded(run: () => Promise<WebToolResult>): Promise<WebToolResult> {
  try {
    return await run();
  } catch (error) {
    return { text: `web tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

/** Search through Exa's hosted MCP endpoint. */
export function webSearch(options: WebOptions, rawQuery: string, requested = 5): Promise<WebToolResult> {
  return guarded(async () => {
    const query = rawQuery.trim();
    if (!query) return { text: "query must not be empty", isError: true };
    const numResults = Math.min(10, Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : 5));
    const result = resultText(await callTool(options, "web_search_exa", { query, numResults }));
    return { text: truncate(result.text || "(no results)"), isError: result.isError };
  });
}

/** Fetch one http(s) page as readable text through Exa's hosted MCP endpoint. */
export function webFetch(options: WebOptions, rawUrl: string): Promise<WebToolResult> {
  return guarded(async () => {
    const url = parseHttpUrl(rawUrl).toString();
    const result = resultText(await callTool(options, "web_fetch_exa", { urls: [url], maxCharacters: 20_000 }));
    return { text: truncate(result.text || "(empty page)"), isError: result.isError };
  });
}
