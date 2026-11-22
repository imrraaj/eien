import type { Attachment, DeliveryFailed, OutboundMessage } from "@eien/io";
import {
  makeSandboxDir,
  resolveInRoot,
  statSandboxFile,
  type CommandFailed,
  type InvalidPath,
  type Sandbox,
} from "@eien/sandbox";
import { formatBytes } from "@eien/shared";
import { Result, TaggedError } from "better-result";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** Moving files between the host and the sandbox, in both directions. */

/** `send_file` pointed at something that is not a regular file. */
export class NotAFile extends TaggedError("NotAFile")<{ path: string; message: string }> {}

/** `send_file` from a conversation no chat owns (subagents report through their parent). */
export class NoChat extends TaggedError("NoChat")<{ message: string }> {}

/**
 * Copy attachments into `<root>/uploads` and return the message the model sees:
 * the user's text plus a note per file. The host copies are deleted either way.
 */
export async function intake(
  sandbox: Sandbox,
  text: string,
  attachments: readonly Attachment[],
): Promise<Result<string, CommandFailed>> {
  if (attachments.length === 0) return Result.ok(text);
  const dir = `${sandbox.root.replace(/\/+$/, "")}/uploads`;

  try {
    return await Result.gen(async function* () {
      yield* Result.await(makeSandboxDir(sandbox, dir));
      const notes: string[] = [];
      for (const file of attachments) {
        const remote = `${dir}/${Date.now().toString(36)}-${file.name}`;
        yield* Result.await(sandbox.copyIn(file.localPath, remote));
        notes.push(`[attached file saved in the sandbox: ${remote} (${file.name}, ${file.mime}, ${formatBytes(file.size)})]`);
      }
      return Result.ok([text || "The user sent this without instructions.", ...notes].join("\n\n"));
    });
  } finally {
    await Promise.all(attachments.map((file) => rm(file.localPath, { force: true }).catch(() => undefined)));
  }
}

/** Copy a sandbox file to a host temp file, hand it to `send`, then clean up. Returns a note for the model. */
export function exportFile(
  sandbox: Sandbox,
  path: string,
  caption: string | undefined,
  send: (message: OutboundMessage) => Promise<Result<void, DeliveryFailed>>,
): Promise<Result<string, InvalidPath | CommandFailed | NotAFile | DeliveryFailed>> {
  return Result.gen(async function* () {
    const remotePath = yield* resolveInRoot(sandbox.root, path);
    const info = yield* Result.await(statSandboxFile(sandbox, remotePath));
    if (!info.type.includes("regular")) {
      yield* new NotAFile({ path: remotePath, message: `${remotePath} is not a regular file (${info.type})` });
    }

    const dir = await mkdtemp(join(tmpdir(), "eien-out-"));
    try {
      const name = basename(remotePath) || "file";
      const localPath = join(dir, name);
      yield* Result.await(sandbox.copyOut(remotePath, localPath));
      yield* Result.await(send({ kind: "file", localPath, name, size: info.size, caption }));
      return Result.ok(`sent ${name} (${formatBytes(info.size)}) to the chat`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
