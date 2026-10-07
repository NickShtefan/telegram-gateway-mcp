import { mkdtempSync, openSync, closeSync, fstatSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { attestFile } from '../posixPermissions.js';
describe.skipIf(process.platform !== 'darwin')('macOS protected-file ACL attestation', () => {
  it('rejects an explicit write ACE even when Unix mode remains 0644', async () => {
    const root=mkdtempSync(join(tmpdir(),'tg-acl-'));const path=join(root,'candidate');let fd: number|undefined;
    try {
      writeFileSync(path,'synthetic verified bytes');chmodSync(path,0o644);fd=openSync(path,'r');
      await expect(attestFile(path,fstatSync(fd))).resolves.toBeUndefined();
      execFileSync('/bin/chmod',['+a',`user:${userInfo().username} allow write`,path]);
      expect(fstatSync(fd).mode&0o777).toBe(0o644);
      await expect(attestFile(path,fstatSync(fd))).rejects.toThrow('protection_unverified');
    } finally {if(fd!==undefined)closeSync(fd);rmSync(root,{recursive:true,force:true})}
  });
});
