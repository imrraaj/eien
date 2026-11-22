import { describe, expect, test } from "bun:test";
import { runCopy } from "../../packages/sandbox/src/process.ts";

describe("runCopy", () => {
    test("succeeds on exit 0", async () => {
        expect((await runCopy("true", [])).isOk()).toBe(true);
    });

    test("returns CommandFailed with stderr on a non-zero exit", async () => {
        const copied = await runCopy("sh", ["-c", "echo 'no route to host' >&2; exit 3"]);
        if (copied.isOk()) throw new Error("expected failure");
        expect(copied.error).toMatchObject({ _tag: "CommandFailed", exitCode: 3, message: "no route to host" });
    });

    test("rejects when the binary is missing: a broken install, not an expected failure", async () => {
        await expect(runCopy("eien-no-such-binary", [])).rejects.toThrow();
    });
});
