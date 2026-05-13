// Atomic-write helper shared across every file ACC has to mutate durably.
//
// Pattern: write to a sibling tmp file (with `wx` so we never collide), fsync
// the file handle so the bytes are on the disk before we rename, then rename
// over the canonical path. If anything in the sequence throws after the tmp
// file has been created, the tmp file is unlinked best-effort so the .acc/
// directory doesn't accumulate orphaned `*.tmp-…` artifacts. Reuses the same
// semantics state.ts originally encoded inline; extracted so workspace.ts and
// advanceArtifact.ts don't drift away from it.

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

export interface AtomicWriteOptions {
  /** File mode for the final file. Defaults to 0o600 (private). */
  mode?: number;
  /** Optional override for the tmp filename's prefix; used purely to make
   * test-fixture leaks obvious. */
  tmpPrefix?: string;
}

/**
 * Write `bytes` to `targetPath` atomically. On any failure the tmp file is
 * unlinked best-effort and the original error is re-thrown to the caller.
 */
export async function atomicWriteFile(
  targetPath: string,
  bytes: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const mode = opts.mode ?? 0o600;
  const dir = path.dirname(targetPath);
  const prefix = opts.tmpPrefix ?? `.${path.basename(targetPath)}.tmp`;
  const tmpPath = path.join(
    dir,
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  let wroteTmp = false;
  try {
    await fsPromises.writeFile(tmpPath, bytes, { flag: 'wx', mode });
    wroteTmp = true;
    const handle = await fsPromises.open(tmpPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsPromises.rename(tmpPath, targetPath);
  } catch (err) {
    if (wroteTmp) {
      await fsPromises.unlink(tmpPath).catch(() => {
        // Best-effort cleanup. If the unlink itself fails (e.g. tmp file
        // already removed by an interleaved process), there's nothing useful
        // to do — re-throw the original failure to the caller.
      });
    }
    throw err;
  }
}
