/** Telegram group mention/reply routing. */

export interface MentionEntity {
    type: string;
    offset: number;
    length: number;
    user?: { id: number; username?: string };
}

export interface GroupGateInput {
    isGroup: boolean;
    text: string;
    botUsername: string;
    botId: number;
    entities?: readonly MentionEntity[];
    replyToBot: boolean;
    /** Names that address the bot in free text, case-insensitive. Defaults to {@link DEFAULT_BOT_NAMES}. */
    botNames?: readonly string[];
}

export interface GroupGateResult {
    respond: boolean;
    text: string;
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** Free-text names that address the bot, e.g. "eien" or "eienbot". */
export const DEFAULT_BOT_NAMES = ["eienbot", "eien"] as const;

function escapeRegExp(value: string): string {
    return value.replace(ESCAPE, "\\$&");
}

/** Whole-word, case-insensitive matcher for the given bot names, longest first so "eienbot" wins over "eien". */
function namePattern(names: readonly string[], flags: string): RegExp {
    const alternatives = [...names]
        .filter((name) => name.length > 0)
        .sort((left, right) => right.length - left.length)
        .map(escapeRegExp);
    if (alternatives.length === 0) return /(?!)/u;
    // Underscore is a word character in Telegram usernames, so reject it explicitly on both sides.
    return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`, `${flags}u`);
}

/** True when the text contains one of the bot's names as a standalone word. */
export function messageNamesBot(text: string, names: readonly string[] = DEFAULT_BOT_NAMES): boolean {
    return namePattern(names, "i").test(text);
}

/** Remove the first `eien`/`eienbot` used to address the bot, keeping later occurrences of the word. */
export function stripBotName(text: string, names: readonly string[] = DEFAULT_BOT_NAMES): string {
    const stripped = text.replace(namePattern(names, "i"), " ");
    return stripped === text ? text : stripped.replace(/\s+/g, " ").trim();
}

/** Remove every `@botusername` occurrence from the message. */
export function stripMention(text: string, botUsername: string): string {
    const mention = new RegExp(`@${escapeRegExp(botUsername)}\\b`, "gi");
    return text.replace(mention, " ").replace(/\s+/g, " ").trim();
}

/**
 * Entity-based mention detection (what Telegram itself considers a mention),
 * with a text fallback for clients/tests that omit entities.
 */
export function messageMentionsBot(input: {
    text: string;
    botUsername: string;
    botId: number;
    entities?: readonly MentionEntity[];
}): boolean {
    const username = input.botUsername.toLowerCase();

    for (const entity of input.entities ?? []) {
        if (entity.type === "mention") {
            const value = input.text.slice(entity.offset, entity.offset + entity.length);
            if (value.toLowerCase() === `@${username}`) return true;
        }
        if (entity.type === "text_mention" && entity.user?.id === input.botId) {
            return true;
        }
    }

    return new RegExp(`@${escapeRegExp(input.botUsername)}\\b`, "i").test(input.text);
}

function commandTargetsBot(text: string, botUsername: string): boolean {
    const target = text.match(/^\/\w+@([A-Za-z0-9_]+)/)?.[1];
    return target?.toLowerCase() === botUsername.toLowerCase();
}

/** Telegram only delivers group commands addressed to a bot; treat them as ours. */
function bareCommand(text: string): boolean {
    return /^\/\w+(?:\s|$)/.test(text);
}

/**
 * In private chats always respond. In groups, respond only when the bot is
 * named, mentioned, replied to, or sent /cmd@botusername.
 */
export function groupGate(input: GroupGateInput): GroupGateResult {
    const names = input.botNames ?? DEFAULT_BOT_NAMES;

    if (!input.isGroup) {
        return { respond: true, text: stripBotName(input.text, names) };
    }

    const addressed =
        messageMentionsBot(input) ||
        messageNamesBot(input.text, names) ||
        input.replyToBot ||
        commandTargetsBot(input.text, input.botUsername) ||
        bareCommand(input.text);

    return {
        respond: addressed,
        text: addressed ? stripBotName(stripMention(input.text, input.botUsername), names) : input.text,
    };
}
