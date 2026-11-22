import { describe, expect, it } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteStorage } from "../../packages/agent/src/sqlite.ts";

registerStorageConformance({ describe, expect, it }, "bun:sqlite storage", async (use) => {
  const dir = await mkdtemp(join(tmpdir(), "eien-sqlite-"));
  const storage = await openSqliteStorage(join(dir, "test.sqlite"));
  try {
    await use(storage);
  } finally {
    await storage.close(BACKGROUND_CONTEXT).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});
