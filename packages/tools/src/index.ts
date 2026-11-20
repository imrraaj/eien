export { runWebTool, webTools, type WebOptions, type WebToolResult } from "./web.ts";

export interface OutgoingFile {
  /** Absolute path inside the sandbox workspace. */
  path: string;
  caption?: string;
}
