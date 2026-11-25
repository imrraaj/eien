import type { StoredFile } from "./protocol.ts";
import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export type { StoredFile };

const ID = /^[0-9a-f-]{36}$/;

/** Files sent to the web chat, in `<dir>/<id>/<name>` with an append-only index beside them. */
export class FileStore {
    constructor(private readonly dir: string) {}

    get #index(): string {
        return join(this.dir, "index.jsonl");
    }

    async add(localPath: string, name: string, size: number, caption?: string): Promise<StoredFile> {
        const file: StoredFile = { id: randomUUID(), name: basename(name) || "file", size, caption, at: Date.now() };
        await mkdir(join(this.dir, file.id), { recursive: true });
        await copyFile(localPath, join(this.dir, file.id, file.name));
        await appendFile(this.#index, `${JSON.stringify(file)}\n`);
        return file;
    }

    /** Newest first. */
    async list(): Promise<StoredFile[]> {
        const text = await readFile(this.#index, "utf8").catch(() => "");
        return text
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line) as StoredFile)
            .reverse();
    }

    async find(id: string): Promise<{ file: StoredFile; path: string } | undefined> {
        if (!ID.test(id)) return undefined;
        const file = (await this.list()).find((each) => each.id === id);
        return file && { file, path: join(this.dir, file.id, file.name) };
    }
}
