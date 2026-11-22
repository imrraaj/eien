import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { addressKey, parseAddressKey } from "../../packages/io/src/address.ts";
import { InputHub } from "../../packages/io/src/inputs.ts";
import { OutputRouter } from "../../packages/io/src/outputs.ts";
import { scrubDashes } from "../../packages/io/src/style.ts";
import type { InboundSink, OutboundMessage, OutputService } from "../../packages/io/src/types.ts";

function recorder(name: string) {
    const sent: Array<[string, OutboundMessage]> = [];
    const service: OutputService = {
        name,
        send: async (chat, message) => {
            sent.push([chat, message]);
            return Result.ok(undefined);
        },
    };
    return { service, sent };
}

describe("addresses", () => {
    test("round-trip, keeping colons in the chat part", () => {
        const address = { service: "web", chat: "user:42" };
        expect(parseAddressKey(addressKey(address))).toEqual(address);
    });

    test("reject keys without both parts", () => {
        expect(parseAddressKey("telegram")).toBeUndefined();
        expect(parseAddressKey(":1")).toBeUndefined();
        expect(parseAddressKey("telegram:")).toBeUndefined();
    });
});

describe("scrubDashes", () => {
    test("replaces em dashes and spaced en dashes", () => {
        expect(scrubDashes("done — tests pass")).toBe("done, tests pass");
        expect(scrubDashes("a—b")).toBe("a, b");
        expect(scrubDashes("left – right")).toBe("left, right");
    });

    test("keeps ranges and hyphens", () => {
        expect(scrubDashes("pages 3–5, well-known")).toBe("pages 3–5, well-known");
    });
});

describe("OutputRouter", () => {
    test("routes by service and scrubs text and captions", async () => {
        const router = new OutputRouter();
        const telegram = recorder("telegram");
        const web = recorder("web");
        router.add(telegram.service);
        router.add(web.service);

        await router.send({ service: "web", chat: "1" }, { kind: "text", text: "hi — there" });
        await router.send(
            { service: "telegram", chat: "2" },
            { kind: "file", localPath: "/tmp/x", name: "x", size: 1, caption: "a — b" },
        );

        expect(web.sent).toEqual([["1", { kind: "text", text: "hi, there" }]]);
        expect(telegram.sent[0]?.[1]).toMatchObject({ kind: "file", caption: "a, b" });
    });

    test("rejects unknown and removed services", async () => {
        const router = new OutputRouter();
        const web = recorder("web");
        router.add(web.service);
        router.remove("web");
        const sent = await router.send({ service: "web", chat: "1" }, { kind: "text", text: "x" });
        expect(sent.isErr() && sent.error.reason).toBe("no_service");
    });

    test("refuses duplicate names", () => {
        const router = new OutputRouter();
        router.add(recorder("web").service);
        expect(() => router.add(recorder("web").service)).toThrow("already registered");
    });
});

describe("InputHub", () => {
    test("starts services with the sink and stops them on remove", async () => {
        const events: string[] = [];
        const sink: InboundSink = async (event) => void events.push(event.id);
        const hub = new InputHub(sink);
        let stopped = false;

        await hub.add({
            name: "fake",
            start: async (next) => {
                await next({ kind: "command", from: { service: "fake", chat: "1" }, id: "e1", name: "help", args: [] });
            },
            stop: async () => {
                stopped = true;
            },
        });
        await hub.remove("fake");

        expect(events).toEqual(["e1"]);
        expect(stopped).toBe(true);
    });

    test("forgets a service whose start fails", async () => {
        const hub = new InputHub(async () => undefined);
        const failing = { name: "x", start: () => Promise.reject(new Error("boom")), stop: async () => undefined };
        await expect(hub.add(failing)).rejects.toThrow("boom");
        await hub.add({ ...failing, start: async () => undefined });
    });
});
