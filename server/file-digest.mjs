import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

/**
 * Hash a regular file in bounded chunks, optionally computing its Git blob ID in the same read.
 * @param {string} path
 * @param {string} [objectFormat]
 */
export async function fileDigest(path, objectFormat = undefined) {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Evidence input is not a regular file: ${path}`);
    const digest = createHash("sha256");
    const blob = objectFormat ? createHash(objectFormat).update(`blob ${before.size}\0`) : null;
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      size += chunk.length;
      digest.update(chunk);
      blob?.update(chunk);
    }
    const after = await handle.stat();
    if (
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error(`Evidence input changed while hashing: ${path}`);
    return { digest: digest.digest("hex"), oid: blob?.digest("hex") ?? null };
  } finally {
    await handle.close();
  }
}
