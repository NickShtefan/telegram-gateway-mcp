/**
 * Safe shared-directory operations. Agents read it under another macOS
 * user, so the daemon treats its contents as untrusted:
 * never follow symlinks or modify other users' files. Otherwise a
 * malicious symlink could expose a session key as an image
 * or overwrite the daemon's `.env` through an export.
 * readBoundedFile is the one reader for protected installer, state and profile files.
 */
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GatewayError } from './errors.js';

const uid = (): number => (typeof process.getuid === 'function' ? process.getuid() : -1);

function untrusted(path: string, why: string): GatewayError {
  return new GatewayError('UNAVAILABLE', `The gateway files directory is not safe to use: ${path} ${why}. The owner has to check who created it.`);
}

/** Existing nonsymlink directory owned by this process and not writable by others. */
function assertTrustedDir(path: string): void {
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

/** Caller policy for readBoundedFile. Owners and mode bits apply on POSIX only; Windows callers attest through `attest`. */
export interface BoundedFilePolicy {
  /** Largest accepted size in bytes. */
  maximum: number;
  /** POSIX: accepted owner uids of the open file. */
  owners?: readonly number[];
  /** POSIX: mode bits that must be clear. */
  modeMask?: number;
  /** Path attestation (ACL, Windows security descriptor, tree listing) of the inode already open as `st`. */
  attest?: (path: string, st: Stats) => Promise<void>;
  /** Error for every policy failure. */
  fail: () => Error;
}

/**
 * Read a whole single-link regular file without following links or blocking on special files. The first lstat, the
 * open descriptor and, after `attest`, a second lstat must name the same device/inode; the read asks for one byte
 * beyond the descriptor size, so growth or shrinkage fails. Only the first lstat and open errors (ENOENT: absent)
 * propagate unchanged; a later ENOENT means the file changed and fails like every other check.
 */
export async function readBoundedFile(path: string, policy: BoundedFilePolicy): Promise<Buffer> {
  const same = (st: Stats, other: Stats): boolean => st.isFile() && !st.isSymbolicLink() && st.dev === other.dev && st.ino === other.ino;
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw policy.fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat(); const posix = process.platform !== 'win32';
    if (!same(st, before) || st.nlink !== 1 || st.size > policy.maximum
      || (posix && ((policy.owners && !policy.owners.includes(st.uid)) || (st.mode & (policy.modeMask ?? 0)) !== 0))) throw policy.fail();
    if (policy.attest) {
      try { await policy.attest(path, st); if (!same(await lstat(path), st)) throw policy.fail(); }
      catch (err) { throw (err as NodeJS.ErrnoException).code === 'ENOENT' ? policy.fail() : err; }
    }
    const bytes = Buffer.alloc(st.size + 1); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== st.size) throw policy.fail();
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}
