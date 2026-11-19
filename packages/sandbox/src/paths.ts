import { posix } from "node:path";

/**
 * Resolve a model-supplied path against the sandbox workspace root and reject
 * anything that escapes it (`..`, absolute paths elsewhere, NUL bytes).
 */
export function resolveInRoot(root: string, userPath: string): string {
  if (!userPath || userPath.includes("\0")) {
    throw new Error("invalid path");
  }

  const normalizedRoot = posix.normalize(root).replace(/\/+$/, "") || "/";
  if (!normalizedRoot.startsWith("/")) {
    throw new Error(`workspace root must be absolute: ${root}`);
  }

  const absolute = posix.normalize(
    userPath.startsWith("/") ? userPath : posix.join(normalizedRoot, userPath),
  );

  if (normalizedRoot === "/") return absolute;
  if (absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`path escapes the workspace (${normalizedRoot}): ${userPath}`);
  }
  return absolute;
}
