import { describe, expect, test } from "bun:test";
import { groupGate, messageMentionsBot, stripMention } from "./mentions.ts";

const bot = "eienbot";
const botId = 9_250_249_177;
const base = { botUsername: bot, botId, replyToBot: false };

describe("groupGate", () => {
  test("always responds in private chats", () => {
    expect(groupGate({ ...base, isGroup: false, text: "hi" })).toEqual({
      respond: true,
      text: "hi",
    });
  });

  test("responds to an @mention and strips it", () => {
    expect(groupGate({ ...base, isGroup: true, text: "@eienbot price of btc" })).toEqual({
      respond: true,
      text: "price of btc",
    });
  });

  test("uses Telegram mention entities", () => {
    const text = "@eienbot what is btc?";
    expect(
      messageMentionsBot({
        text,
        botUsername: bot,
        botId,
        entities: [{ type: "mention", offset: 0, length: 9 }],
      }),
    ).toBe(true);
  });

  test("uses text_mention entities for the bot id", () => {
    expect(
      messageMentionsBot({
        text: "eien what is btc?",
        botUsername: bot,
        botId,
        entities: [{ type: "text_mention", offset: 0, length: 4, user: { id: botId } }],
      }),
    ).toBe(true);
  });

  test("mention matching is case-insensitive", () => {
    expect(groupGate({ ...base, isGroup: true, text: "@EienBot hi" }).text).toBe("hi");
  });

  test("responds when replying to the bot", () => {
    expect(
      groupGate({ ...base, isGroup: true, replyToBot: true, text: "and now?" }),
    ).toEqual({ respond: true, text: "and now?" });
  });

  test("responds to /cmd@botusername", () => {
    expect(groupGate({ ...base, isGroup: true, text: "/status@eienbot" })).toEqual({
      respond: true,
      text: "/status",
    });
  });

  test("ignores unaddressed group messages and other bots", () => {
    expect(groupGate({ ...base, isGroup: true, text: "hello everyone" }).respond).toBe(false);
    expect(groupGate({ ...base, isGroup: true, text: "@otherbot hi" }).respond).toBe(false);
    expect(groupGate({ ...base, isGroup: true, text: "/status@otherbot" }).respond).toBe(false);
  });

  test("does not match a longer username", () => {
    expect(groupGate({ ...base, isGroup: true, text: "@eienbot2 hi" }).respond).toBe(false);
  });

  test("stripMention removes all occurrences", () => {
    expect(stripMention("@eienbot hi @eienbot there", bot)).toBe("hi there");
  });
});
