# Independently reviewed verification entry. No service/UAC activation here.
param([Parameter(Mandatory=$true)][string]$Bundle,[Parameter(Mandatory=$true)][string]$SignerSha256,[Parameter(Mandatory=$true)][string]$SourceSha)
$ErrorActionPreference='Stop'
function Fail { throw 'bootstrap_verification_failed' }
function Regular([string]$Path,[long]$Maximum) {
  $item=Get-Item -LiteralPath $Path -Force
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt $Maximum) { Fail }
  return $item
}
function BoundedBytes([string]$Path,[long]$Maximum) {
  $null=Regular $Path $Maximum
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {
    if($stream.Length -gt $Maximum){Fail}
    $memory=New-Object IO.MemoryStream
    try {
      $buffer=New-Object byte[] 65536
      while(($count=$stream.Read($buffer,0,$buffer.Length)) -gt 0){if($memory.Length+$count -gt $Maximum){Fail};$memory.Write($buffer,0,$count)}
      return ,$memory.ToArray()
    } finally {$memory.Dispose()}
  } finally {$stream.Dispose()}
}
function HashBytes([byte[]]$Bytes) {
  $sha=[Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
try {
  if($SignerSha256 -cnotmatch '^[0-9a-f]{64}$' -or $SourceSha -cnotmatch '^[0-9a-f]{40}$') { Fail }
  $manifestPath=Join-Path $Bundle 'manifest.tsv';$signaturePath=Join-Path $Bundle 'manifest.sig';$certificatePath=Join-Path $Bundle 'signer.der'
  $null=Regular $manifestPath 8192;$signatureItem=Regular $signaturePath 384;$null=Regular $certificatePath 16384
  if($signatureItem.Length -ne 384){Fail}
  [byte[]]$manifest=(BoundedBytes $manifestPath 8192);[byte[]]$signature=(BoundedBytes $signaturePath 384);[byte[]]$certificateBytes=(BoundedBytes $certificatePath 16384)
  if((HashBytes $certificateBytes) -cne $SignerSha256){Fail}
  $certificate=New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$certificateBytes)
  $rsa=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
  try {
    if($rsa.KeySize -ne 3072 -or -not $rsa.VerifyData($manifest,$signature,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)){Fail}
  } finally { $rsa.Dispose();$certificate.Dispose() }
  foreach($byte in $manifest){if($byte -gt 127 -or ($byte -lt 32 -and $byte -ne 9 -and $byte -ne 10)){Fail}}
  $lines=([Text.Encoding]::ASCII.GetString($manifest)).Split([char]10)
  if($lines.Length -ne 13 -or $lines[12] -cne '' -or $lines[0] -cne 'TG_MCP_RELEASE_V1' -or $lines[1] -cne "version`t0.2.0" -or $lines[2] -cne "source_sha`t$SourceSha" -or $lines[3] -cne "platform`twin32"){Fail}
  $arch=if([Environment]::Is64BitOperatingSystem){'x64'}else{Fail}
  if($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'){$arch='arm64'}
  if($lines[4] -cne "architecture`t$arch" -or $lines[5] -cnotmatch '^node_version\t(22|24)\.[0-9]{1,3}\.[0-9]{1,3}$'){Fail}
  $nodeVersion=$lines[5].Split([char]9)[1];$numbers=$nodeVersion.Split('.')
  if($numbers[0] -eq '22' -and [int]$numbers[1] -lt 13){Fail}
  $roles=@('node','installer','manifest_helper','archive_helper','application','node_license');$names=@('node.exe','installer.mjs','manifest.mjs','archive.mjs','application.tar.gz','NODE_LICENSE')
  for($i=0;$i -lt 6;$i++) {
    $fields=$lines[$i+6].Split([char]9);$max=if($i -eq 0 -or $i -eq 4){134217728}else{1048576}
    if($fields.Length -ne 5 -or $fields[0] -cne 'file' -or $fields[1] -cne $roles[$i] -or $fields[2] -cne $names[$i] -or $fields[3] -cnotmatch '^[1-9][0-9]{0,8}$' -or [long]$fields[3] -gt $max -or $fields[4] -cnotmatch '^[0-9a-f]{64}$'){Fail}
    $path=Join-Path $Bundle $names[$i];$item=Regular $path $max
    if($item.Length -ne [long]$fields[3]){Fail}
    [byte[]]$bytes=(BoundedBytes $path $max)
    if($bytes.Length -ne [long]$fields[3] -or (HashBytes $bytes) -cne $fields[4]){Fail}
  }
  # Verification does not execute agent-writable Node/helpers or grant administration.
  @{format_version=1;phase='bundle_verified';version='0.2.0';source_sha=$SourceSha;platform='win32';architecture=$arch;node_version=$nodeVersion;installed=$false}|ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine('{"format_version":1,"error_code":"bootstrap_verification_failed"}');exit 1 }
