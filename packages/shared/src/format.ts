/** Human-readable size: 512 B, 1.5 KB, 3.2 MB. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Message for logs and replies; non-Error throwables are stringified. */
export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
