/** Delays, durations, and schedule listing shared by the tool and the bot commands. */

/** Parse a delay like "30s", "2m", "1h", "2d"; a bare number is minutes. */
export function parseDelay(input: string): number | undefined {
  const match = input
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hours?|d|days?)?$/);
  if (!match) return undefined;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;

  const unit = match[2] ?? "m";
  const factor = unit.startsWith("s")
    ? 1_000
    : unit.startsWith("h")
      ? 3_600_000
      : unit.startsWith("d")
        ? 86_400_000
        : 60_000;
  return Math.round(value * factor);
}

/** Compact human duration: 45s, 15m, 2h, 3d. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export interface ScheduleInfo {
  name: string;
  prompt: string;
  everyMs?: number;
  nextAt: number;
}

const PREVIEW = 80;

function preview(prompt: string): string {
  const line = prompt.split("\n")[0]?.trim() ?? "";
  return line.length > PREVIEW ? `${line.slice(0, PREVIEW - 1).trimEnd()}…` : line;
}

/** One line per schedule: `name: in 12m, every 15m. prompt preview`. */
export function formatSchedules(items: ScheduleInfo[], now: number): string {
  if (items.length === 0) return "No schedules.";

  return [...items]
    .sort((a, b) => a.nextAt - b.nextAt)
    .map((item) => {
      const when = item.nextAt <= now ? "due now" : `in ${formatDuration(item.nextAt - now)}`;
      const every = item.everyMs === undefined ? "" : `, every ${formatDuration(item.everyMs)}`;
      return `${item.name}: ${when}${every}. ${preview(item.prompt)}`;
    })
    .join("\n");
}
