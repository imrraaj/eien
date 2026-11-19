import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LogFile {
  path: string;
  write(line: string): void;
}

/** Append-only JSONL log with a single-file rotation at `maxBytes`. */
export function createLogFile(dir: string, maxBytes = 5_000_000): LogFile {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "gateway.log");

  return {
    path,
    write(line: string): void {
      try {
        if (existsSync(path) && statSync(path).size > maxBytes) {
          renameSync(path, `${path}.1`);
        }
        appendFileSync(path, `${line}\n`);
      } catch {
        // Logging must never break the bot.
      }
    },
  };
}
