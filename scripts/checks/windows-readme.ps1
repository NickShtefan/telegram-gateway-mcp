# Parse the user commands only. Never execute README elevation/install operations.
$ErrorActionPreference='Stop'
$text=Get-Content README.md -Raw
$blocks=[regex]::Matches($text,'(?s)```powershell\r?\n(.*?)```')
if($blocks.Count -ne 1){throw 'Windows README command block missing'}
$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseInput($blocks[0].Groups[1].Value,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Windows README command syntax failed'}
if(-not $blocks[0].Groups[1].Value.Contains('tg-mcp-owner.cmd')){throw 'short owner command missing'}
