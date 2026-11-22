import { Result } from "better-result";
import { posix } from "node:path";
import { InvalidPath } from "./errors.ts";

/**
 * Resolve a model-supplied path against the sandbox workspace root and reject
 * anything that escapes it (`..`, absolute paths elsewhere, NUL bytes).
 * A relative root is a configuration bug and throws.
 */
export function resolveInRoot(root: string, userPath: string): Result<string, InvalidPath> {
  if (!userPath || userPath.includes("\0")) {
    return Result.err(new InvalidPath({ path: userPath, message: "invalid path" }));
  }

  const normalizedRoot = posix.normalize(root).replace(/\/+$/, "") || "/";
  if (!normalizedRoot.startsWith("/")) throw new Error(`workspace root must be absolute: ${root}`);

  const absolute = posix.normalize(userPath.startsWith("/") ? userPath : posix.join(normalizedRoot, userPath));
  if (normalizedRoot !== "/" && absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}/`)) {
    return Result.err(
      new InvalidPath({ path: userPath, message: `path escapes the workspace (${normalizedRoot}): ${userPath}` }),
    );
  }
  return Result.ok(absolute);
}
