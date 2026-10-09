// Builder-only readers. Call only after verifying the complete official archive digest.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export function runtimeEntry(archive, entry, maximum, zip) {
  if(zip && process.platform==='win32') {
    const directory=mkdtempSync(join(tmpdir(),'tg-runtime-entry-'));const output=join(directory,'payload');
    try {
      // Large base64 stdout through Windows PowerShell is prohibitively slow.
      // Keep bytes in an exclusive builder-owned temporary file, not text pipes.
      const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;$request=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TG_RUNTIME_REQUEST))|ConvertFrom-Json);$zip=[IO.Compression.ZipFile]::OpenRead($request.archive);try{$entries=@($zip.Entries|Where-Object {$_.FullName -ceq $request.entry});if($entries.Count -ne 1 -or $entries[0].Length -gt $request.maximum){throw 'invalid entry'};$stream=$entries[0].Open();$file=[IO.File]::Open($request.output,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$buffer=New-Object byte[] 65536;$total=0;while(($count=$stream.Read($buffer,0,$buffer.Length)) -gt 0){$total+=$count;if($total -gt $request.maximum){throw 'oversize'};$file.Write($buffer,0,$count)}}finally{$file.Dispose();$stream.Dispose()}}finally{$zip.Dispose()}`;
      execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{maxBuffer:1024,timeout:30000,env:{SystemRoot:'C:\\Windows',TG_RUNTIME_REQUEST:Buffer.from(JSON.stringify({archive,entry,maximum,output})).toString('base64')}});
      const st=lstatSync(output);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>maximum)throw new Error('runtime_entry_budget');
      const bytes=readFileSync(output);if(bytes.length!==st.size||bytes.length>maximum)throw new Error('runtime_entry_budget');return bytes;
    } finally {rmSync(directory,{recursive:true,force:true})}

  }
  return execFileSync(zip?'/usr/bin/unzip':'/usr/bin/tar',zip?['-p',archive,entry]:['-xOf',archive,entry],{maxBuffer:maximum,timeout:30000});
}
