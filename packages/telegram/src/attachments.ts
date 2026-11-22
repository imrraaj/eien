import type { Attachment } from "@eien/io";
import { Result, TaggedError } from "better-result";
import type { Context } from "grammy";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The attachment could not be fetched from Telegram. */
export class DownloadFailed extends TaggedError("DownloadFailed")<{ message: string; cause?: unknown }> {}

/** Bot API downloads stop at 20 MB. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

interface FileRef {
    fileId: string;
    size?: number;
    name: string;
    mime: string;
}

function safeName(raw: string, fallback: string): string {
    const cleaned = raw
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^[._]+/, "")
        .slice(0, 120);
    return cleaned || fallback;
}

function fileRef(ctx: Context): FileRef | undefined {
    const message = ctx.message;
    if (!message) return undefined;

    if (message.document) {
        const { file_id, file_size, file_name, file_unique_id, mime_type } = message.document;
        return {
            fileId: file_id,
            size: file_size,
            name: safeName(file_name ?? `document-${file_unique_id}`, "document"),
            mime: mime_type ?? "application/octet-stream",
        };
    }
    const photo = message.photo?.at(-1);
    if (photo) {
        return {
            fileId: photo.file_id,
            size: photo.file_size,
            name: `photo-${photo.file_unique_id}.jpg`,
            mime: "image/jpeg",
        };
    }
    if (message.video) {
        const { file_id, file_size, file_name, file_unique_id, mime_type } = message.video;
        return {
            fileId: file_id,
            size: file_size,
            name: safeName(file_name ?? `video-${file_unique_id}.mp4`, "video.mp4"),
            mime: mime_type ?? "video/mp4",
        };
    }
    if (message.audio) {
        const { file_id, file_size, file_name, file_unique_id, mime_type } = message.audio;
        return {
            fileId: file_id,
            size: file_size,
            name: safeName(file_name ?? `audio-${file_unique_id}.mp3`, "audio.mp3"),
            mime: mime_type ?? "audio/mpeg",
        };
    }
    if (message.voice) {
        const { file_id, file_size, file_unique_id, mime_type } = message.voice;
        return {
            fileId: file_id,
            size: file_size,
            name: `voice-${file_unique_id}.ogg`,
            mime: mime_type ?? "audio/ogg",
        };
    }
    if (message.video_note) {
        const { file_id, file_size, file_unique_id } = message.video_note;
        return { fileId: file_id, size: file_size, name: `video-note-${file_unique_id}.mp4`, mime: "video/mp4" };
    }
    return undefined;
}

/** Download the message's attachment to a host temp file. `undefined` when it has none. */
export function downloadAttachment(
    ctx: Context,
    token: string,
): Promise<Result<Attachment | undefined, DownloadFailed>> {
    return Result.gen(async function* () {
        const ref = fileRef(ctx);
        if (!ref) return Result.ok(undefined);
        if (ref.size !== undefined && ref.size > MAX_DOWNLOAD_BYTES) {
            yield* new DownloadFailed({ message: "Telegram only lets bots download files up to 20 MB" });
        }

        const fail = (message: string) => (cause: unknown) =>
            new DownloadFailed({ message: `${message}: ${String(cause)}`, cause });
        const file = yield* Result.await(
            Result.tryPromise({ try: () => ctx.api.getFile(ref.fileId), catch: fail("Telegram refused the file") }),
        );
        if (!file.file_path) yield* new DownloadFailed({ message: "Telegram did not return a file path" });

        const response = yield* Result.await(
            Result.tryPromise({
                try: () => fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`),
                catch: fail("download failed"),
            }),
        );
        if (!response.ok) yield* new DownloadFailed({ message: `download failed (HTTP ${response.status})` });

        const bytes = new Uint8Array(await response.arrayBuffer());
        const localPath = join(tmpdir(), `eien-in-${randomUUID()}-${ref.name}`);
        await writeFile(localPath, bytes);
        return Result.ok({ localPath, name: ref.name, mime: ref.mime, size: bytes.length });
    });
}
