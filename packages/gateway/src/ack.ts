/** Short acknowledgement shown when a turn runs longer than a few seconds. */

const MAX_PREVIEW = 100;

/** One-line, tag-free preview of the user's request for the ack message. */
export function ackText(prompt: string): string {
  const line =
    prompt
      .split("\n")
      .map((part) => part.trim())
      .find(Boolean) ?? "";

  const clean = line
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return "On it — working on it.\nI'll post the result here when it's done.";

  const preview =
    clean.length > MAX_PREVIEW ? `${clean.slice(0, MAX_PREVIEW - 1).trimEnd()}…` : clean;

  return `On it — ${preview}\nI'll post the result here when it's done.`;
}
