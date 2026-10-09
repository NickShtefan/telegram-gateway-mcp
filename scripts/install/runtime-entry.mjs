// Builder-only readers. Call only after verifying the complete official archive digest.
import { execFileSync } from 'node:child_process';
export function runtimeEntry(archive, entry, maximum, zip) {
  if(zip && process.platform==='win32') {
    const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;$request=[Console]::In.ReadToEnd()|ConvertFrom-Json;$zip=[IO.Compression.ZipFile]::OpenRead($request.archive);try{$entries=@($zip.Entries|Where-Object {$_.FullName -ceq $request.entry});if($entries.Count -ne 1 -or $entries[0].Length -gt $request.maximum){throw 'invalid entry'};$stream=$entries[0].Open();try{$memory=New-Object IO.MemoryStream;$buffer=New-Object byte[] 65536;while(($count=$stream.Read($buffer,0,$buffer.Length)) -gt 0){if($memory.Length+$count -gt $request.maximum){throw 'oversize'};$memory.Write($buffer,0,$count)};[Console]::Out.Write([Convert]::ToBase64String($memory.ToArray()))}finally{$stream.Dispose()}}finally{$zip.Dispose()}`;
    const encoded=execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{input:JSON.stringify({archive,entry,maximum}),encoding:'ascii',maxBuffer:Math.ceil(maximum*4/3)+16,timeout:30000,env:{SystemRoot:'C:\\Windows'}});
    const bytes=Buffer.from(encoded,'base64');if(bytes.length>maximum)throw new Error('runtime_entry_budget');return bytes;
  }
  return execFileSync(zip?'/usr/bin/unzip':'/usr/bin/tar',zip?['-p',archive,entry]:['-xOf',archive,entry],{maxBuffer:maximum,timeout:30000});
}
