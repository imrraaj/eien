import type { Attachment } from "@eien/io";
import { shellQuote, type Sandbox } from "@eien/sandbox";
import { formatBytes } from "@eien/shared";
import { rm } from "node:fs/promises";

/**
 * Move attachments into `<root>/uploads` and describe them for the model.
 * The host copies are deleted either way.
 */
export async function ingestAttachments(sandbox: Sandbox, attachments: readonly Attachment[]): Promise<string[]> {
  if (attachments.length === 0) return [];
  const dir = `${sandbox.root.replace(/\/+$/, "")}/uploads`;

  try {
    const mkdir = await sandbox.exec(`mkdir -p ${shellQuote(dir)}`, { timeoutMs: 15_000 });
    if (mkdir.exitCode !== 0) throw new Error(mkdir.output.trim() || "could not create the uploads directory");

    const notes: string[] = [];
    for (const file of attachments) {
      const remote = `${dir}/${Date.now().toString(36)}-${file.name}`;
      await sandbox.copyIn(file.localPath, remote);
      notes.push(`[attached file saved in the sandbox: ${remote} (${file.name}, ${file.mime}, ${formatBytes(file.size)})]`);
    }
    return notes;
  } finally {
    await Promise.all(attachments.map((file) => rm(file.localPath, { force: true }).catch(() => undefined)));
  }
}
