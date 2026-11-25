import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../packages/agent/src/memory.ts";

const dirs: string[] = [];

async function store(limit = 1024): Promise<MemoryStore> {
    const dir = await mkdtemp(join(tmpdir(), "eien-memory-"));
    dirs.push(dir);
    return new MemoryStore(join(dir, "memory.md"), limit);
}

afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("MemoryStore", () => {
    test("a missing file is empty memory", async () => {
        expect((await (await store()).read()).unwrap()).toBe("");
    });

    test("append adds a newline between entries and keeps both", async () => {
        const memory = await store();
        (await memory.write("first")).unwrap();
        (await memory.write("second")).unwrap();

        expect((await memory.read()).unwrap()).toBe("first\nsecond");
    });

    test("replace rewrites the whole file", async () => {
        const memory = await store();
        (await memory.write("old")).unwrap();
        (await memory.write("new", "replace")).unwrap();

        expect((await memory.read()).unwrap()).toBe("new");
    });

    test("memory_replace updates exactly one occurrence", async () => {
        const memory = await store();
        (await memory.write("alpha\nbeta\nalpha")).unwrap();
        const result = (await memory.replace("beta", "BETA")).unwrap();

        expect(result).toContain(":2");
        expect((await memory.read()).unwrap()).toBe("alpha\nBETA\nalpha");
    });

    test("memory_replace refuses empty, missing, and ambiguous matches", async () => {
        const memory = await store();
        (await memory.write("same\nsame")).unwrap();

        const empty = await memory.replace("", "x");
        const missing = await memory.replace("nope", "x");
        const ambiguous = await memory.replace("same", "x");

        expect(empty.isErr() && empty.error._tag).toBe("MemoryEditRefused");
        expect(missing.isErr() && missing.error._tag === "MemoryEditRefused" && missing.error.reason).toBe("not_found");
        expect(ambiguous.isErr() && ambiguous.error._tag === "MemoryEditRefused" && ambiguous.error.reason).toBe(
            "ambiguous",
        );
    });

    test("writes beyond the limit are refused without changing the file", async () => {
        const memory = await store(8);
        (await memory.write("1234")).unwrap();
        const result = await memory.write("56789");

        expect(result.isErr() && result.error._tag).toBe("MemoryFull");
        expect((await memory.read()).unwrap()).toBe("1234");
    });

    test("concurrent appends are serialized", async () => {
        const memory = await store();
        await Promise.all(Array.from({ length: 20 }, (_, index) => memory.write(`line-${index}`)));

        const text = (await memory.read()).unwrap();
        const lines = text.split("\n");
        expect(lines).toHaveLength(20);
        expect(new Set(lines).size).toBe(20);
    });

    test("the file is private to the gateway user", async () => {
        const memory = await store();
        (await memory.write("secret-ish")).unwrap();

        expect((await stat(memory.path)).mode & 0o777).toBe(0o600);
        expect(await readFile(memory.path, "utf8")).toBe("secret-ish");
    });
});
