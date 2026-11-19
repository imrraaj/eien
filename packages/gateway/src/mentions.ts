/** Telegram group mention/reply routing. */

export interface GroupGateInput {
  isGroup: boolean;
  text: string;
  botUsername: string;
  replyToBot: boolean;
}

export interface GroupGateResult {
  respond: boolean;
  text: string;
}

const MENTION_SAFE = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(MENTION_SAFE, "\\$&");
}

/** Remove every `@botusername` occurrence from the message. */
export function stripMention(text: string, botUsername: string): string {
  const mention = new RegExp(`@${escapeRegExp(botUsername)}\\b`, "gi");
  return text.replace(mention, " ").replace(/\s+/g, " ").trim();
}

function mentionsBot(text: string, botUsername: string): boolean {
  return new RegExp(`@${escapeRegExp(botUsername)}\\b`, "i").test(text);
}

function commandTargetsBot(text: string, botUsername: string): boolean {
  const target = text.match(/^\/\w+@([A-Za-z0-9_]+)/)?.[1];
  return target?.toLowerCase() === botUsername.toLowerCase();
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
    mentionsBot(input.text, input.botUsername) ||
    input.replyToBot ||
    commandTargetsBot(input.text, input.botUsername);

  return {
    respond: addressed,
    text: addressed ? stripMention(input.text, input.botUsername) : input.text,
  };
}
