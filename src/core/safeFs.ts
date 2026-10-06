/**
 * Safe shared-directory operations. Agents read it under another macOS
 * user, so the daemon treats its contents as untrusted:
 * never follow symlinks or modify other users' files. Otherwise a
 * malicious symlink could expose a session key as an image
 * or overwrite the daemon's `.env` through an export.
 */
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { GatewayError } from './errors.js';

const uid = (): number => (typeof process.getuid === 'function' ? process.getuid() : -1);

function untrusted(path: string, why: string): GatewayError {
  return new GatewayError('UNAVAILABLE', `The gateway files directory is not safe to use: ${path} ${why}. The owner has to check who created it.`);
}

/** Existing nonsymlink directory owned by this process and not writable by others. */
export function assertTrustedDir(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw untrusted(path, 'is a symbolic link');
  if (!st.isDirectory()) throw untrusted(path, 'is not a directory');
  if (uid() !== -1 && st.uid !== uid()) throw untrusted(path, 'belongs to another user');
  if ((st.mode & 0o022) !== 0) throw untrusted(path, 'is writable by other users');
}

/** Create/check directories up to `root`; mode 755 lets agents read and only the daemon write. */
export function ensureTrustedDir(path: string, root: string): void {
  const chain: string[] = [];
  for (let current = path; current.startsWith(root) && current.length >= root.length; current = dirname(current)) {
    chain.unshift(current);
    if (current === root) break;
  }
  if (chain[0] !== root) throw untrusted(path, 'is outside the files directory');
  // Create the shared directory and parents; it may be absent during development.
  mkdirSync(root, { recursive: true, mode: 0o755 });
  for (const dir of chain) {
    try {
      mkdirSync(dir, { mode: 0o755 });
      chmodSync(dir, 0o755);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    assertTrustedDir(dir);
  }
}

/** Regular file owned by this process, not a symlink or another user's file. */
export function isOwnRegularFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && (uid() === -1 || st.uid === uid());
  } catch {
    return false;
  }
}

/**
 * Open a new output file. Replace existing own files; reject other users'
 * files and symlinks. Never follow a symlink.
 */
export function openNewFile(path: string, mode = 0o644): number {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  try {
    return openSync(path, flags, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (!isOwnRegularFile(path)) throw untrusted(path, 'exists and is not a file of the gateway');
    unlinkSync(path);
    return openSync(path, flags, mode);
  }
}

export function writeNewFile(path: string, data: Buffer, mode = 0o644): void {
  const fd = openNewFile(path, mode);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, mode);
}

/** Read an owned regular file without following links; null if absent, foreign, or oversized. */
export function readOwnFile(path: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (uid() !== -1 && st.uid !== uid()) || st.size > maxBytes) return null;
    const buffer = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const read = readSync(fd, buffer, offset, st.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}
