/** Read only a root-published allowlisted projection, never the authoritative service journal. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { z } from 'zod';
import { parseSafe, SetupError, setupIdSchema, statusSchema } from './contract.js';
import { PROGRESS_PATH } from './preflight.js';

const snapshotSchema = z.strictObject({
  observed_at_ms: z.number().int().nonnegative(), status: statusSchema,
});
export type ProgressSnapshot = z.infer<typeof snapshotSchema>;
const runFile = promisify(execFile);

export function decodeProgress(raw: unknown, setupId: string, now = Date.now()): ProgressSnapshot {
  const id = parseSafe(setupIdSchema, setupId, 'invalid_request');
  const snapshot = parseSafe(snapshotSchema, raw, 'unsafe_progress');
  if (snapshot.status.setup_id !== id) throw new SetupError('status_unavailable');
  if (snapshot.observed_at_ms > now || now - snapshot.observed_at_ms > 60_000) throw new SetupError('stale_progress');
  return snapshot;
}

/** Filesystem primitive for adapters/tests; CLI status still uses only its fixed root-owned path. */
export async function readSnapshotFile(path: string, setupId: string, ownerUid: number): Promise<ProgressSnapshot> {
  const existing = await lstat(path);
  if (!existing.isFile() || existing.isSymbolicLink()) throw new SetupError('unsafe_progress');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.uid !== ownerUid || st.nlink !== 1 || (st.mode & 0o022) !== 0 || st.size > 16_384) throw new SetupError('unsafe_progress');
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16_384) throw new SetupError('unsafe_progress');
    let raw: unknown;
    try { raw = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); } catch { throw new SetupError('unsafe_progress'); }
    return decodeProgress(raw, setupId);
  } finally { await file.close(); }
}

export async function readProgress(setupId: string): Promise<ProgressSnapshot> {
  parseSafe(setupIdSchema, setupId, 'invalid_request');
  if (process.platform !== 'darwin') throw new SetupError('unsupported_platform');
  try {
    // A root-owned projection is distinct from service-owned authoritative state.
    // Reject any ACL instead of assuming Unix modes prove macOS access restrictions.
    for (let path = dirname(PROGRESS_PATH); ; path = dirname(path)) {
      const st = await lstat(path);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0) throw new SetupError('unsafe_progress');
      const { stdout } = await runFile('/bin/ls', ['-lde', path], { maxBuffer: 8192, timeout: 1000 });
      if (/\n\s*\d+:/.test(stdout) || stdout.split('\n')[0]?.[10] === '+') throw new SetupError('unsafe_progress');
      if (path === '/') break;
    }
    const existing = await lstat(PROGRESS_PATH);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new SetupError('unsafe_progress');
    const { stdout } = await runFile('/bin/ls', ['-lde', PROGRESS_PATH], { maxBuffer: 8192, timeout: 1000 });
    if (/\n\s*\d+:/.test(stdout) || stdout.split('\n')[0]?.[10] === '+') throw new SetupError('unsafe_progress');
    return await readSnapshotFile(PROGRESS_PATH, setupId, 0);
  } catch (err) {
    if (err instanceof SetupError) throw err;
    throw new SetupError('status_unavailable');
  }
}
