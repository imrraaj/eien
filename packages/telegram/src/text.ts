/** Telegram's hard limit is 4096 UTF-8 characters; stay under it. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const DEFAULT_LIMIT = 4000;

function isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
}

/** True when the text carries words or numbers, not just punctuation, emoji, or whitespace. */
export function hasContent(text: string): boolean {
    return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Split text into Telegram-sized chunks, preferring newline then space
 * boundaries. Never splits a surrogate pair (emoji, some CJK).
 */
export function splitMessage(text: string, limit = DEFAULT_LIMIT): string[] {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError("limit must be a positive integer");
    }
    if (text.length <= limit) return [text];

    const chunks: string[] = [];
    let rest = text;

    while (rest.length > limit) {
        let cut = rest.lastIndexOf("\n", limit);
        if (cut <= 0) cut = rest.lastIndexOf(" ", limit);
        if (cut <= 0) cut = limit;

        // Do not cut between a high and low surrogate.
        if (cut > 0 && isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1;

        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, "");
    }

    if (rest.length > 0) chunks.push(rest);
    return chunks;
}
