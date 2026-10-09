// Synthetic native ZIP-reader proof, no network, runtime execution or privileged operation.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeEntry } from '../install/runtime-entry.mjs';
const root=mkdtempSync(join(tmpdir(),'tg-runtime-fixture-'));
try {
  const archive=join(root,'fixture.zip');
  execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem;$file=[IO.File]::Open($env:TG_TEST_ARCHIVE,[IO.FileMode]::CreateNew);$zip=New-Object IO.Compression.ZipArchive($file,[IO.Compression.ZipArchiveMode]::Create);try{$entry=$zip.CreateEntry('payload');$stream=$entry.Open();try{$bytes=New-Object byte[] 4194304;$bytes[4194303]=123;$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}}finally{$zip.Dispose();$file.Dispose()}`],{stdio:['ignore','pipe','pipe'],timeout:30000,env:{SystemRoot:'C:\\Windows',TG_TEST_ARCHIVE:archive}});
  const bytes=runtimeEntry(archive,'payload',4194304,true);
  if(bytes.length!==4194304||bytes[4194303]!==123)throw new Error('binary reader mismatch');
  let rejected=false;try{runtimeEntry(archive,'payload',4194303,true)}catch{rejected=true};if(!rejected)throw new Error('budget not enforced');
  rejected=false;try{runtimeEntry(archive,'missing',4194304,true)}catch{rejected=true};if(!rejected)throw new Error('missing entry accepted');
  console.log(JSON.stringify({bytes:bytes.length,budget_rejection:true,missing_rejection:true}));
} finally {rmSync(root,{recursive:true,force:true})}
