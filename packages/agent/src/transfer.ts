import type { Attachment, OutboundMessage } from "@eien/io";
import { shellQuote, statSandboxFile, type Sandbox } from "@eien/sandbox";
import { formatBytes } from "@eien/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** Moving files between the host and the sandbox, in both directions. */

/**
 * Copy attachments into `<root>/uploads` and return the message the model sees:
 * the user's text plus a note per file. The host copies are deleted either way.
 */
export async function intake(sandbox: Sandbox, text: string, attachments: readonly Attachment[]): Promise<string> {
  if (attachments.length === 0) return text;
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
    return [text || "The user sent this without instructions.", ...notes].join("\n\n");
  } finally {
    await Promise.all(attachments.map((file) => rm(file.localPath, { force: true }).catch(() => undefined)));
  }
}

/** Copy a sandbox file to a host temp file, hand it to `send`, then clean up. Returns a note for the model. */
export async function exportFile(
  sandbox: Sandbox,
  remotePath: string,
  caption: string | undefined,
  send: (message: OutboundMessage) => Promise<void>,
): Promise<string> {
  const info = await statSandboxFile(sandbox, remotePath);
  if (!info.type.includes("regular")) throw new Error(`${remotePath} is not a regular file (${info.type})`);

  const dir = await mkdtemp(join(tmpdir(), "eien-out-"));
  const name = basename(remotePath) || "file";
  try {
    const localPath = join(dir, name);
    await sandbox.copyOut(remotePath, localPath);
    await send({ kind: "file", localPath, name, size: info.size, caption });
    return `sent ${name} (${formatBytes(info.size)}) to the chat`;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
