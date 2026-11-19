import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  copyFromSandbox,
  copyToSandbox,
  sbxExec,
  shellQuote,
  statSandboxFile,
  type SandboxConfig,
} from "@eien/sandbox";
import type { OutgoingFile } from "@eien/tools";
import { InputFile, type Context } from "grammy";

/** Telegram Bot API caps downloads at 20 MB and bot uploads at 50 MB. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface IngestedFile {
  /** Absolute path inside the sandbox workspace. */
  path: string;
  name: string;
  kind: string;
  size: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 120);
  return cleaned || fallback;
}

async function uploadHostFile(
  ctx: Context,
  localPath: string,
  name: string,
  caption: string | undefined,
): Promise<void> {
  await ctx.replyWithDocument(new InputFile(createReadStream(localPath), name), {
    caption,
  });
}

/** Copy a workspace file out of the sandbox and upload it to the chat. */
export async function sendSandboxFile(
  ctx: Context,
  sandbox: SandboxConfig,
  file: OutgoingFile,
): Promise<string> {
  const info = await statSandboxFile(sandbox, file.path);
  if (!info.type.includes("regular")) {
    throw new Error(`${file.path} is not a regular file (${info.type})`);
  }
  if (info.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `file is ${formatBytes(info.size)}; Telegram allows at most ${formatBytes(MAX_UPLOAD_BYTES)}`,
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "eien-send-"));
  const name = basename(file.path) || "file";
  const local = join(dir, name);

  try {
    await copyFromSandbox(sandbox, file.path, local);
    await uploadHostFile(ctx, local, name, file.caption);
    return `sent ${name} (${formatBytes(info.size)}) to the chat`;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface TelegramFileRef {
  fileId: string;
  name: string;
  kind: string;
}

function telegramFileRef(ctx: Context): TelegramFileRef | undefined {
  const message = ctx.message;
  if (!message) return undefined;

  if (message.document) {
    const doc = message.document;
    return {
      fileId: doc.file_id,
      name: safeName(doc.file_name ?? `document-${doc.file_unique_id}`, "document"),
      kind: doc.mime_type ?? "document",
    };
  }

  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    if (!photo) return undefined;
    return {
      fileId: photo.file_id,
      name: `photo-${photo.file_unique_id}.jpg`,
      kind: "image/jpeg",
    };
  }

  if (message.video) {
    const video = message.video;
    return {
      fileId: video.file_id,
      name: safeName(video.file_name ?? `video-${video.file_unique_id}.mp4`, "video.mp4"),
      kind: video.mime_type ?? "video/mp4",
    };
  }

  if (message.audio) {
    const audio = message.audio;
    return {
      fileId: audio.file_id,
      name: safeName(audio.file_name ?? `audio-${audio.file_unique_id}.mp3`, "audio.mp3"),
      kind: audio.mime_type ?? "audio/mpeg",
    };
  }

  if (message.voice) {
    const voice = message.voice;
    return {
      fileId: voice.file_id,
      name: `voice-${voice.file_unique_id}.ogg`,
      kind: voice.mime_type ?? "audio/ogg",
    };
  }

  if (message.video_note) {
    const note = message.video_note;
    return {
      fileId: note.file_id,
      name: `video-note-${note.file_unique_id}.mp4`,
      kind: "video/mp4",
    };
  }

  return undefined;
}

/**
 * Download a Telegram attachment and place it in `<root>/uploads`.
 * Returns undefined when the message has no supported attachment.
 */
export async function ingestTelegramFile(
  ctx: Context,
  sandbox: SandboxConfig,
  root: string,
  botToken: string,
): Promise<IngestedFile | undefined> {
  const ref = telegramFileRef(ctx);
  if (!ref) return undefined;

  const file = await ctx.api.getFile(ref.fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path");

  const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
  if (!response.ok) {
    throw new Error(`download failed (HTTP ${response.status})`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const dir = await mkdtemp(join(tmpdir(), "eien-in-"));
  const local = join(dir, ref.name);
  const remoteDir = `${root.replace(/\/+$/, "")}/uploads`;
  const remote = `${remoteDir}/${Date.now().toString(36)}-${ref.name}`;

  try {
    await writeFile(local, bytes);
    const mkdir = await sbxExec(sandbox, `mkdir -p ${shellQuote(remoteDir)}`, {
      timeoutMs: 15_000,
    });
    if (mkdir.exitCode !== 0) {
      throw new Error(mkdir.output.trim() || "could not create the uploads directory");
    }
    await copyToSandbox(sandbox, local, remote);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  return { path: remote, name: ref.name, kind: ref.kind, size: bytes.length };
}

/** Human-readable note that points the model at an ingested file. */
export function describeIngestedFile(file: IngestedFile): string {
  return `[attached file saved in the sandbox: ${file.path} (${file.name}, ${file.kind}, ${formatBytes(file.size)})]`;
}

export { formatBytes };
