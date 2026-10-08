# Run the installed script in an elevated human terminal, with agents and capture stopped.
param([Parameter(Mandatory=$true)][string]$SourceSha)
$ErrorActionPreference='Stop'
$service='TelegramMCPGateway';$started=$false;$frozen=$false;$mailbox=$null;$ownerLock=$null;$failed=$false
try {
  if($SourceSha -cnotmatch '^[0-9a-f]{40}$'){throw 'invalid'}
  $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or [Console]::IsInputRedirected){throw 'invalid'}
  $prefix='C:\ProgramData\TelegramMCPGateway';$release=Join-Path (Join-Path $prefix 'releases') $SourceSha
  $source=Join-Path $release 'application\dist\setup\provision-windows.ps1'
  # The installed bootstrap and code have already been independently authenticated.
  # Load only its checked-in protection functions, never the provisioning body.
  # Verify the imported file and all parents before evaluating even function definitions.
  $bootstrapItem=Get-Item -LiteralPath $source -Force
  for($item=$bootstrapItem;$item;$item=if($item -is [IO.DirectoryInfo]){$item.Parent}else{$item.Directory}){
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'invalid'}
    $acl=Get-Acl -LiteralPath $item.FullName
    $owner=if($acl.Owner -match '^S-1-'){$acl.Owner}else{(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value}
    if($owner -notin @('S-1-5-32-544','S-1-5-18')){throw 'invalid'}
    $mutation=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    if($item.FullName -in @('C:\','C:\ProgramData')){$mutation=$mutation -band (-bnot ([Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories))}
    foreach($rule in $acl.Access){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-32-544','S-1-5-18') -and ($rule.FileSystemRights -band $mutation)){throw 'invalid'}}
  }
  $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
  if($errors.Count){throw 'invalid'}
  $functions=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)
  foreach($name in @('Fail','NoReparse','Sid','AssertProtected','AssertAncestors','AssertTree','Protect')){
    $definition=@($functions|Where-Object {$_.Name -ceq $name});if($definition.Count -ne 1){throw 'invalid'}
    . ([scriptblock]::Create($definition[0].Extent.Text))
  }
  AssertAncestors $release;AssertTree (Get-Item -LiteralPath $release)
  $sc=Join-Path ([Environment]::GetFolderPath('System')) 'sc.exe'
  $sid=(New-Object Security.Principal.NTAccount('NT SERVICE\TelegramMCPGateway')).Translate([Security.Principal.SecurityIdentifier]).Value
  $receiptPath=Join-Path $prefix 'install.json';$null=AssertProtected $receiptPath
  if((Get-Item -LiteralPath $receiptPath).Length -gt 16384){throw 'invalid'}
  $receipt=Get-Content -LiteralPath $receiptPath -Raw|ConvertFrom-Json
  if($receipt.source_sha -cne $SourceSha -or $receipt.stage -cne 'complete'){throw 'invalid'}
  $definition=Join-Path $prefix 'service.json';$null=AssertProtected $definition
  if((Get-Item -LiteralPath $definition).Length -gt 16384){throw 'invalid'}
  $config=Get-Content -LiteralPath $definition -Raw|ConvertFrom-Json
  if($config.node -cne (Join-Path $release 'node.exe') -or $config.entry -cne (Join-Path $release 'application\dist\cli\index.js') -or $config.state -cne (Join-Path $prefix 'state')){throw 'invalid'}
  $existing=Get-CimInstance Win32_Service -Filter "Name='TelegramMCPGateway'"
  $hostPath=Join-Path $release 'application\dist\native\service-host.exe'
  if($existing.StartName -cne 'NT SERVICE\TelegramMCPGateway' -or $existing.PathName -cne ('"'+$hostPath+'"') -or $existing.StartMode -cne 'Manual'){throw 'invalid'}
  $lockPath=Join-Path $prefix 'owner-windows.lock'
  if(Test-Path -LiteralPath $lockPath){$null=AssertProtected $lockPath}
  $ownerLock=New-Object IO.FileStream($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  Protect $lockPath '' $true $false
  $wasRunning=$existing.State -eq 'Running'
  [Console]::Error.WriteLine('Stop all agents and disable terminal capture/UI automation. Same-user software is outside this protection.')
  if((Read-Host 'Type OWNER READY after completing those steps') -cne 'OWNER READY'){throw 'invalid'}
  $account=Read-Host 'Gateway account id';$user=Read-Host 'Gateway user id'
  if($account -cnotmatch '^[a-z0-9][a-z0-9_-]{0,31}$' -or $user -cnotmatch '^[a-z0-9][a-z0-9_-]{0,31}$'){throw 'invalid'}
  # Freeze the installed recovery policy before stopping the existing owner.
  $null=& $sc failure $service reset= 86400 actions= '""';if($LASTEXITCODE -ne 0){throw 'invalid'};$frozen=$true
  Stop-Service $service;(Get-Service $service).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))
  AssertTree (Get-Item -LiteralPath $config.state) $sid $true $true
  $mailbox=Join-Path $prefix 'owner-setup'
  if(Test-Path -LiteralPath $mailbox){AssertTree (Get-Item -LiteralPath $mailbox) $sid $true $true}
  else{$null=New-Item -ItemType Directory -Path $mailbox;Protect $mailbox $sid $true $true}
  $planPath=Join-Path $mailbox 'plan.json'
  $id=[guid]::NewGuid().ToString()
  if(Test-Path -LiteralPath $planPath){
    $null=AssertProtected $planPath $sid $true $true
    if((Get-Item -LiteralPath $planPath).Length -gt 2048){throw 'invalid'}
    $saved=Get-Content -LiteralPath $planPath -Raw|ConvertFrom-Json
    if($saved.source_sha -cne $SourceSha -or $saved.plan.account -cne $account -or $saved.plan.user -cne $user){throw 'invalid'}
    $id=$saved.plan.setup_id
  } else {
    @{format_version=1;source_sha=$SourceSha;plan=@{setup_id=$id;account=$account;user=$user;replace_session=$false;rotate_token=$false}}|ConvertTo-Json -Compress|Set-Content -LiteralPath $planPath -Encoding UTF8
    Protect $planPath $sid $true $false
  }
  if($id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'){throw 'invalid'}
  foreach($name in @('answer.json','answer.json.next','request.json','request.json.next')){
    $path=Join-Path $mailbox $name
    if(Test-Path -LiteralPath $path){$null=AssertProtected $path $sid $true $true;Remove-Item -LiteralPath $path}
  }
  $null=& $sc start $service owner-setup $id;if($LASTEXITCODE -ne 0){throw 'invalid'};$started=$true
  $questions=@{api_id='Telegram application id';api_hash='Telegram application hash';phone='Telegram phone (international format)';code='Telegram verification code';password='Telegram two-factor password'}
  $sequence=0;$deadline=[DateTime]::UtcNow.AddMinutes(15);$requestPath=Join-Path $mailbox 'request.json';$result=$null
  while([DateTime]::UtcNow -lt $deadline){
    if(Test-Path -LiteralPath $requestPath){
      $item=AssertProtected $requestPath $sid $true $true
      if($item.PSIsContainer -or $item.Length -gt 2048){throw 'invalid'}
      $request=Get-Content -LiteralPath $requestPath -Raw|ConvertFrom-Json
      if($request.kind -ceq 'result'){$result=$request.result;break}
      if($request.kind -cne 'prompt' -or -not $questions.ContainsKey($request.question)){throw 'invalid'}
      if($request.sequence -eq $sequence){Start-Sleep -Milliseconds 100;continue}
      if($request.sequence -ne ($sequence+1)){throw 'invalid'};$sequence++
      $secure=Read-Host $questions[$request.question] -AsSecureString
      $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try{$answer=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer);if($answer.Length -gt 512){throw 'invalid'}
        $path=Join-Path $mailbox 'answer.json.next'
        @{kind='answer';sequence=$sequence;value=$answer}|ConvertTo-Json -Compress|Set-Content -LiteralPath $path -Encoding UTF8
        Protect $path $sid $true $true;Move-Item -LiteralPath $path -Destination (Join-Path $mailbox 'answer.json')
      } finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer);$secure.Dispose();$answer=$null}
    } elseif((Get-Service $service).Status -eq 'Stopped'){throw 'invalid'}
    Start-Sleep -Milliseconds 100
  }
  if($null -eq $result -or $result.setup_id -cne $id -or $result.format_version -ne 1 -or $result.phase -notin @('needs_client_configuration','needs_existing_client_credential','failed') -or $result.error_code -notin @($null,'invalid_owner_input','owner_step_failed')){throw 'invalid'}
  # Emit an explicit allowlist, never arbitrary service-private fields.
  @{format_version=1;setup_id=$id;phase=$result.phase;error_code=$result.error_code}|ConvertTo-Json -Compress
} catch {[Console]::Error.WriteLine('{"format_version":1,"error_code":"owner_step_failed"}');$failed=$true}
finally {
  if($started){Stop-Service $service;(Get-Service $service).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(30))}
  if($mailbox){foreach($name in @('answer.json','answer.json.next','request.json','request.json.next')){$path=Join-Path $mailbox $name;if(Test-Path -LiteralPath $path){$null=AssertProtected $path $sid $true $true;Remove-Item -LiteralPath $path}}}
  if($frozen){$null=& $sc failure $service reset= 86400 actions= restart/3000/restart/10000/restart/30000;if($LASTEXITCODE -ne 0){throw 'owner_restore_failed'};if($wasRunning){Start-Service $service}}
  if($ownerLock){$ownerLock.Dispose()}
}
if($failed -or ($result -and $result.phase -ceq 'failed')){exit 1}


