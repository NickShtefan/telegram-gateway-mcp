import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform === 'darwin') {
  const source=fileURLToPath(new URL('./install/lease-helper.c',import.meta.url));
  const output=fileURLToPath(new URL('../dist/native/lease-darwin',import.meta.url));
  mkdirSync(new URL('../dist/native/',import.meta.url),{recursive:true});
  execFileSync('/usr/bin/clang',['-arch','arm64','-arch','x86_64','-mmacosx-version-min=13.0','-Os','-Wall','-Wextra','-Werror',source,'-o',output],{stdio:'inherit',timeout:30000});
}
