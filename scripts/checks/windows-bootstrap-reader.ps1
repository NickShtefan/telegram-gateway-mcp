# Synthetic handle-reader regressions. Never run bootstrap body, elevation or provisioning.
$ErrorActionPreference='Stop'
$source=(Resolve-Path -LiteralPath 'scripts/install/bootstrap-windows.ps1').Path
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse failed'}
foreach($name in @('Fail','NativeReader','BoundedBytes')){
  $function=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true)
  if(@($function).Count -ne 1){throw 'missing helper'};. ([scriptblock]::Create($function[0].Extent.Text))
}
$directory=Join-Path ([IO.Path]::GetTempPath()) ('tg-reader-'+[guid]::NewGuid().ToString());$null=New-Item -ItemType Directory -Path $directory
try {
  $file=Join-Path $directory 'regular';[IO.File]::WriteAllBytes($file,[byte[]](1,2,3))
  [byte[]]$bytes=BoundedBytes $file 3
  if($bytes.Length -ne 3 -or $bytes[2] -ne 3){throw 'regular reader failed'}
  $failed=$false;try{$null=BoundedBytes $file 2}catch{$failed=$true};if(-not $failed){throw 'oversize accepted'}
  $link=Join-Path $directory 'hardlink';$null=New-Item -ItemType HardLink -Path $link -Target $file
  $failed=$false;try{$null=BoundedBytes $link 3}catch{$failed=$true};if(-not $failed){throw 'hardlink accepted'}
  $failed=$false;try{$null=BoundedBytes $directory 3}catch{$failed=$true};if(-not $failed){throw 'directory accepted'}
}finally{Remove-Item -LiteralPath $directory -Recurse -Force}
