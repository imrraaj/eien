import { describe, expect, test } from "bun:test";
import { groupGate, messageMentionsBot, stripMention } from "../../packages/telegram/src/mentions.ts";

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
        expect(groupGate({ ...base, isGroup: true, replyToBot: true, text: "and now?" })).toEqual({
            respond: true,
            text: "and now?",
        });
    });

    test("responds to /cmd@botusername", () => {
        expect(groupGate({ ...base, isGroup: true, text: "/status@eienbot" })).toEqual({
            respond: true,
            text: "/status",
        });
    });

    test("responds to bare commands in groups", () => {
        expect(groupGate({ ...base, isGroup: true, text: "/stop" })).toEqual({
            respond: true,
            text: "/stop",
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

    test("responds when named in a group and strips the addressing name", () => {
        expect(groupGate({ ...base, isGroup: true, text: "eienbot price of btc" })).toEqual({
            respond: true,
            text: "price of btc",
        });
        expect(groupGate({ ...base, isGroup: true, text: "hey Eien can you check this" }).text).toBe(
            "hey can you check this",
        );
    });

    test("keeps later occurrences of the name", () => {
        expect(groupGate({ ...base, isGroup: true, text: "eien what is eien" }).text).toBe("what is eien");
    });

    test("only matches the name as a standalone word", () => {
        expect(groupGate({ ...base, isGroup: true, text: "eienbot2 hi" }).respond).toBe(false);
        expect(groupGate({ ...base, isGroup: true, text: "eienish hi" }).respond).toBe(false);
        expect(groupGate({ ...base, isGroup: true, text: "xeien hi" }).respond).toBe(false);
    });

    test("strips a name in private chats too", () => {
        expect(groupGate({ ...base, isGroup: false, text: "eien hello" })).toEqual({
            respond: true,
            text: "hello",
        });
    });

    test("accepts custom bot names", () => {
        expect(groupGate({ ...base, isGroup: true, text: "helper ping", botNames: ["helper"] })).toEqual({
            respond: true,
            text: "ping",
        });
    });

    test("responds to the bot's own username as a name", () => {
        expect(groupGate({ ...base, botUsername: "eienrobot", isGroup: true, text: "eienrobot hi" })).toEqual({
            respond: true,
            text: "hi",
        });
    });

    test("stripMention removes all occurrences", () => {
        expect(stripMention("@eienbot hi @eienbot there", bot)).toBe("hi there");
    });
});
