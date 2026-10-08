/** Root coordinator control: freeze supervision and prove stopped before service-worker login. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installLayout, type InstallLayout } from '../install/platform.js';
import { dirname, basename, join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { attestAncestry, newProtectedDirectory, writeProtectedFile } from '../install/posixPermissions.js';
import { readProtectedRootFile } from './installed.js';
import { SetupError } from './contract.js';
const run = promisify(execFile);
const options = { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, timeout: 15000, maxBuffer: 16384 };
export interface StoppedService { wasRunning: boolean; restore(): Promise<void>; }

export async function stopPosixService(layout: InstallLayout): Promise<StoppedService> {
  if (process.getuid?.() !== 0 || process.platform !== layout.platform || layout.platform === 'win32') throw new SetupError('protection_unverified');
  if (JSON.stringify(layout) !== JSON.stringify(installLayout(layout.platform, basename(layout.release)))) throw new SetupError('protection_unverified');
  if (layout.platform === 'darwin') {
    const target = `system/${layout.service}`;
    let wasRunning = false;
    try { await run('/bin/launchctl', ['print', target], options); wasRunning = true; } catch { /* An unloaded initial service is expected. */ }
    await run('/bin/launchctl', ['disable', target], options);
    if (wasRunning) await run('/bin/launchctl', ['bootout', target], options);
    // The worker, running as the service owner, must acquire the session lease.
    // A root probe cannot use the service-owned lease's owner-only API.
    return { wasRunning, restore: async () => {
      if (!wasRunning) return;
      await run('/bin/launchctl', ['enable', target], options);
      await run('/bin/launchctl', ['bootstrap', 'system', layout.definition], options);
    } };
  }
  const unit = `${layout.service}.service`;
  let wasRunning = false;
  try { const result = await run('/usr/bin/systemctl', ['is-active', unit], options); wasRunning = result.stdout.trim() === 'active'; } catch { /* Initial/inactive unit. */ }
  // A /run mask is shadowed by our unit in /etc. A runtime drop-in disables
  // automatic restarts; explicit starts still cannot bypass the session lease.
  const dropDirectory = `/run/systemd/system/${unit}.d`; const dropFile = join(dropDirectory, 'owner-setup.conf');
  try { await attestAncestry(dropDirectory); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await newProtectedDirectory(dropDirectory, 0, 0, 0o755);
  }
  const definition = Buffer.from('[Service]\nRestart=no\n');
  // A killed coordinator leaves this nonsecret fixed drop-in. Resume only the
  // exact protected bytes, never remove or replace an unrelated administrator file.
  try {
    if (!(await readProtectedRootFile(dropFile, 1024)).equals(definition)) throw new SetupError('protection_unverified');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await writeProtectedFile(dropDirectory, basename(dropFile), definition, 0o644);
  }
  await run('/usr/bin/systemctl', ['daemon-reload'], options);
  await run('/usr/bin/systemctl', ['stop', unit], options);
  return { wasRunning, restore: async () => {
    await attestAncestry(dirname(dropFile));
    if (!(await readProtectedRootFile(dropFile, 1024)).equals(definition)) throw new SetupError('protection_unverified');
    await unlink(dropFile); await run('/usr/bin/systemctl', ['daemon-reload'], options);
    if (wasRunning) await run('/usr/bin/systemctl', ['start', unit], options);
  } };
}
