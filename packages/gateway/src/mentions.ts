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
}

export interface GroupGateResult {
  respond: boolean;
  text: string;
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(ESCAPE, "\\$&");
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
 * mentioned, when replying to one of its messages, or for /cmd@botusername.
 */
export function groupGate(input: GroupGateInput): GroupGateResult {
  if (!input.isGroup) {
    return { respond: true, text: input.text };
  }

  const addressed =
    messageMentionsBot(input) ||
    input.replyToBot ||
    commandTargetsBot(input.text, input.botUsername) ||
    bareCommand(input.text);

  return {
    respond: addressed,
    text: addressed ? stripMention(input.text, input.botUsername) : input.text,
  };
}
