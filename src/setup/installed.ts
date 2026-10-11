/** Read the immutable installed profile before any owner-side mutation. */
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { attestAncestry, attestDirectory, attestFile } from '../install/posixPermissions.js';
import { receiptSchema, type ProvisionReceipt } from '../install/provision.js';
import { installLayout, serviceDefinition, type InstallLayout } from '../install/platform.js';
import { parseSafe, SetupError } from './contract.js';

export async function readProtectedRootFile(path: string, maximum: number): Promise<Buffer> {
  await attestAncestry(dirname(path));
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new SetupError('protection_unverified');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o022) || st.size > maximum) throw new SetupError('protection_unverified');
    await attestFile(path, st);
    const bytes = Buffer.alloc(st.size + 1); const result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== st.size) throw new SetupError('invalid_state');
    return bytes.subarray(0, st.size);
  } finally { await file.close(); }
}
export async function installedPosixProfile(sourceSha: string): Promise<{ layout: InstallLayout; receipt: ProvisionReceipt }> {
  if (process.getuid?.() !== 0 || !['darwin', 'linux'].includes(process.platform)) throw new SetupError('protection_unverified');
  const layout = installLayout(process.platform as 'darwin' | 'linux', sourceSha);
  const receipt = parseSafe(receiptSchema, JSON.parse((await readProtectedRootFile(join(layout.prefix, 'install.json'), 16384)).toString('utf8')));
  if (receipt.plan.source_sha !== sourceSha || receipt.plan.platform !== process.platform || receipt.completed.join(',') !== 'identity,release,state,definition,commands'
    || receipt.identity?.kind !== 'posix') throw new SetupError('invalid_state');
  let count = 0;
  const walk = async (directory: string): Promise<void> => {
    await attestAncestry(directory);
    for (const name of await readdir(directory)) {
      if (++count > 20000) throw new SetupError('invalid_state');
      const path = join(directory, name); const st = await lstat(path);
      if (st.isDirectory() && !st.isSymbolicLink()) await walk(path);
      else {
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o022)) throw new SetupError('protection_unverified');
        await attestFile(path, st);
      }
    }
  };
  await walk(layout.release);
  if (!(await readProtectedRootFile(layout.definition, 16384)).equals(Buffer.from(serviceDefinition(layout, receipt.plan.port)))) throw new SetupError('protection_unverified');
  await attestAncestry(dirname(layout.state));
  await attestDirectory(layout.state, [receipt.identity.uid], 0o077);
  return { layout, receipt };
}
/**
 * Receipt, service definition and state attestation without the release walk (thousands of ACL probes).
 * Only for root-started children of a coordinator that has just attested the release with installedPosixProfile.
 */
export async function installedPosixChildProfile(sourceSha: string): Promise<{ layout: InstallLayout; receipt: ProvisionReceipt }> {
  if (process.getuid?.() !== 0 || !['darwin', 'linux'].includes(process.platform)) throw new SetupError('protection_unverified');
  const layout = installLayout(process.platform as 'darwin' | 'linux', sourceSha);
  const receipt = parseSafe(receiptSchema, JSON.parse((await readProtectedRootFile(join(layout.prefix, 'install.json'), 16384)).toString('utf8')));
  if (receipt.plan.source_sha !== sourceSha || receipt.plan.platform !== process.platform || receipt.completed.join(',') !== 'identity,release,state,definition,commands'
    || receipt.identity?.kind !== 'posix') throw new SetupError('invalid_state');
  if (!(await readProtectedRootFile(layout.definition, 16384)).equals(Buffer.from(serviceDefinition(layout, receipt.plan.port)))) throw new SetupError('protection_unverified');
  await attestAncestry(dirname(layout.state));
  await attestDirectory(layout.state, [receipt.identity.uid], 0o077);
  return { layout, receipt };
}
