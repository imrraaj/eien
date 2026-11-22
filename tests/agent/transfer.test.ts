import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { DeliveryFailed, type OutboundMessage } from "../../packages/io/src/index.ts";
import { exportFile, intake } from "../../packages/agent/src/transfer.ts";
import type { ExecResult, Sandbox } from "../../packages/sandbox/src/types.ts";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (output: string, exitCode = 0): ExecResult => ({ output, exitCode, timedOut: false, truncated: false });

function sandbox(reply: (command: string) => ExecResult): Sandbox & { copiedIn: string[] } {
    const copiedIn: string[] = [];
    return {
        driver: "fake",
        name: "fake",
        root: "/work",
        copiedIn,
        exec: async (command) => reply(command),
        copyIn: async (_local, remote) => {
            copiedIn.push(remote);
            return Result.ok(undefined);
        },
        copyOut: async (_remote, local) => {
            await writeFile(local, "data");
            return Result.ok(undefined);
        },
    };
}

describe("exportFile", () => {
    test("hands the copied file to the output and reports it", async () => {
        const sent: OutboundMessage[] = [];
        const result = await exportFile(
            sandbox(() => run("regular file|4")),
            "out/a.txt",
            "here",
            async (message) => {
                sent.push(message);
                return Result.ok(undefined);
            },
        );
        expect(result.unwrap()).toBe("sent a.txt (4 B) to the chat");
        expect(sent[0]).toMatchObject({ kind: "file", name: "a.txt", size: 4, caption: "here" });
    });

    test("passes each failure through as a typed error", async () => {
        const never = async () => Result.ok(undefined);
        const escape = await exportFile(
            sandbox(() => run("")),
            "../x",
            undefined,
            never,
        );
        const missing = await exportFile(
            sandbox(() => run("No such file", 1)),
            "x",
            undefined,
            never,
        );
        const directory = await exportFile(
            sandbox(() => run("directory|0")),
            "x",
            undefined,
            never,
        );
        const tooLarge = await exportFile(
            sandbox(() => run("regular file|99")),
            "x",
            undefined,
            async () => Result.err(new DeliveryFailed({ service: "test", reason: "too_large", message: "too big" })),
        );
        expect([escape, missing, directory, tooLarge].map((result) => result.isErr() && result.error._tag)).toEqual([
            "InvalidPath",
            "CommandFailed",
            "NotAFile",
            "DeliveryFailed",
        ]);
    });
});

describe("intake", () => {
    test("passes text through when there are no attachments", async () => {
        expect(
            (
                await intake(
                    sandbox(() => run("")),
                    "hi",
                    [],
                )
            ).unwrap(),
        ).toBe("hi");
    });

    test("copies attachments, describes them, and deletes the host copies", async () => {
        const local = join(tmpdir(), `eien-intake-${Date.now()}.txt`);
        await writeFile(local, "x");
        const box = sandbox(() => run(""));
        const message = (
            await intake(box, "", [{ localPath: local, name: "a.txt", mime: "text/plain", size: 1 }])
        ).unwrap();

        expect(message).toStartWith("The user sent this without instructions.");
        expect(message).toContain("/work/uploads/");
        expect(box.copiedIn[0]).toEndWith("-a.txt");
        expect(existsSync(local)).toBe(false);
    });

    test("reports a failed mkdir and still deletes the host copies", async () => {
        const local = join(tmpdir(), `eien-intake-fail-${Date.now()}.txt`);
        await writeFile(local, "x");
        const result = await intake(
            sandbox(() => run("read-only", 1)),
            "hi",
            [{ localPath: local, name: "a.txt", mime: "text/plain", size: 1 }],
        );
        expect(result.isErr() && result.error._tag).toBe("CommandFailed");
        expect(existsSync(local)).toBe(false);
    });
});
