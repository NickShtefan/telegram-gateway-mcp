# Signed ZIP bootstrap regression with a disposable in-memory certificate. No Node/service execution.
$ErrorActionPreference='Stop'
$root=Join-Path ([IO.Path]::GetTempPath()) ('tg-signed-zip-'+[guid]::NewGuid().ToString());$null=New-Item -ItemType Directory $root
# Windows PowerShell 5.1: RSA.Create() returns a provider whose KeySize cannot be set; ask CNG for 3072 bits directly.
$rsa=New-Object Security.Cryptography.RSACng 3072
try {
  $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Synthetic Windows Release Fixture',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $cert=$request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1),[DateTimeOffset]::Now.AddDays(1));[byte[]]$der=$cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)
  function Hash([byte[]]$Bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
  $pin=Hash $der;$source='a'*40;$roles=@('node','installer','manifest_helper','archive_helper','application','node_license');$names=@('node.exe','installer.mjs','manifest.mjs','archive.mjs','application.tar.gz','NODE_LICENSE')
  $lines=@('TG_MCP_RELEASE_V1',"version`t0.2.0","source_sha`t$source","platform`twin32","architecture`tx64","node_version`t24.21.0")
  $payload=@{};foreach($name in $names){$payload[$name]=[byte[]](42)}
  for($i=0;$i -lt 6;$i++){$digest=Hash $payload[$names[$i]];$lines+= "file`t$($roles[$i])`t$($names[$i])`t1`t$digest"}
  [byte[]]$manifest=[Text.Encoding]::ASCII.GetBytes(($lines -join "`n")+"`n")
  $payload['manifest.tsv']=$manifest;$payload['manifest.sig']=$rsa.SignData($manifest,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1);$payload['signer.der']=$der
  $framework=Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319';$null=[Reflection.Assembly]::LoadFrom((Join-Path $framework 'System.IO.Compression.dll'))
  function WriteZip([string]$Path){$file=[IO.File]::Open($Path,[IO.FileMode]::CreateNew);$zip=[IO.Compression.ZipArchive]::new($file,[IO.Compression.ZipArchiveMode]::Create,$false);try{foreach($name in $payload.Keys){$entry=$zip.CreateEntry($name);$output=$entry.Open();try{$output.Write($payload[$name],0,$payload[$name].Length)}finally{$output.Dispose()}}}finally{$zip.Dispose();$file.Dispose()}}
  $fixture=Join-Path $root 'bootstrap.ps1';$original=Get-Content scripts/install/bootstrap-windows.ps1 -Raw
  [IO.File]::WriteAllText($fixture,$original.Replace('f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682',$pin))
  $archive=Join-Path $root 'good.zip';WriteZip $archive
  $powershell=Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
  $result=& $powershell -NoLogo -NoProfile -NonInteractive -File $fixture -Archive $archive
  if($LASTEXITCODE -ne 0){throw 'signed archive rejected'};$meta=$result|ConvertFrom-Json
  if($meta.source_sha -cne $source -or $meta.phase -cne 'bundle_verified' -or $meta.installed){throw 'archive identity failed'}
  $payload['node.exe']=[byte[]](43);$bad=Join-Path $root 'bad.zip';WriteZip $bad
  $previous=$ErrorActionPreference;$ErrorActionPreference='Continue'
  try { & $powershell -NoLogo -NoProfile -NonInteractive -File $fixture -Archive $bad 2>$null; $rejectedExit=$LASTEXITCODE } finally { $ErrorActionPreference=$previous }
  if($rejectedExit -eq 0){throw 'tampered archive accepted'}
  $cert.Dispose()
  $global:LASTEXITCODE=0
  Write-Output 'Signed Windows ZIP and payload tamper rejection passed.'
}finally{$rsa.Dispose();Remove-Item -LiteralPath $root -Recurse -Force}
