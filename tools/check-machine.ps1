# What this machine will do to a Volery wall left open on it: whether it
# sleeps on mains, and whether Windows signs the user back in after a restart
# so the wall's `Run` entry fires with nobody at the keyboard.
#
# Written for AU-LT-288 (2026-10-09), a company laptop with no admin rights:
# run it there in an ordinary PowerShell, and paste the output back. Read-only
# — it changes nothing. Two lines want admin (`manage-bde`, `powercfg
# /requests`) and say so rather than failing the run. The reasoning behind each
# reading is `.claude/rules/machine.md`.
#
#   powershell -ExecutionPolicy Bypass -File tools\check-machine.ps1

$ErrorActionPreference = 'SilentlyContinue'
function Say($label, $value) { '{0,-34} {1}' -f $label, $value }

'== who and what'
Say 'machine' $env:COMPUTERNAME
Say 'user' "$env:USERDOMAIN\$env:USERNAME"
$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
Say 'sid' $sid
$join = dsregcmd /status | Select-String 'AzureAdJoined|DomainJoined|WorkplaceJoined|EnterpriseJoined'
$join | ForEach-Object { Say ($_.Line.Trim() -split ':')[0].Trim() ($_.Line -split ':')[1].Trim() }
$entra = (Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\CloudDomainJoin\JoinInfo' | Measure-Object).Count -gt 0
$ad = (Get-CimInstance Win32_ComputerSystem).PartOfDomain
$managed = $entra -or $ad
Say 'managed (AD or Entra joined)' $managed

''
'== automatic restart sign-on (ARSO)'
$pol = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
Say 'DisableAutomaticRestartSignOn' ($(if ($null -eq $pol.DisableAutomaticRestartSignOn) { '(not set)' } else { $pol.DisableAutomaticRestartSignOn }))
Say 'AutomaticRestartSignOnConfig' ($(if ($null -eq $pol.AutomaticRestartSignOnConfig) { '(not set: only if BitLocker is on)' } else { $pol.AutomaticRestartSignOnConfig }))
$arso = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\UserARSO\$sid"
Say 'UserARSO OptOut (her switch)' ($(if ($null -eq $arso.OptOut) { '(never touched: windows default)' } elseif ($arso.OptOut -eq 0) { '0 = on' } else { "$($arso.OptOut) = off" }))
$restart = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Winlogon').RestartApps
Say 'RestartApps (restartable apps)' ($(if ($null -eq $restart) { '(not set)' } else { $restart }))
$bl = manage-bde -status C: 2>&1
if ($LASTEXITCODE -eq 0) {
  $bl | Select-String 'Protection Status|Conversion Status|Statut de la protection|tat de la conversion' | ForEach-Object { Say 'bitlocker' $_.Line.Trim() }
} else {
  Say 'bitlocker' '(manage-bde needs admin; see Settings > Privacy & security > Device encryption)'
}

''
'== sleep'
$caps = powercfg /a
$s0 = [bool]($caps | Select-String 'S0' | Select-Object -First 1)
Say 'modern standby (S0) listed' $s0
# `/qh`, not `/q`: the lid action is a hidden setting on some machines, and
# `/q` then prints the scheme and nothing under it.
$lid = powercfg /qh SCHEME_CURRENT SUB_BUTTONS LIDACTION |
  Select-String ':\s*0x0000000[0-3]\s*$' | ForEach-Object { $_.Line.Trim() }
Say 'lid action (AC, then DC)' (($lid | ForEach-Object { ($_ -split ':')[-1].Trim() }) -join ' / ')
'                                   0 nothing, 1 sleep, 2 hibernate, 3 shut down'
$req = powercfg /requests 2>&1
if ($LASTEXITCODE -eq 0) { '-- powercfg /requests'; $req } else { Say 'powercfg /requests' '(needs admin)' }

''
'== what that means for a wall left open here'
$reach = if ($pol.DisableAutomaticRestartSignOn -eq 1) { 'only once she signs in: policy has turned ARSO off' }
  elseif ($arso.OptOut -eq 1) { 'only once she signs in: her own switch is off (Settings > Accounts > Sign-in options)' }
  elseif ($managed) { 'after Windows Update restarts only (managed machine), and only if BitLocker/TPM/Secure Boot hold' }
  else { 'after any restart or shutdown she did not sign out of' }
Say 'comes back by itself' $reach
Say 'never comes back by itself' 'power loss, a hard crash, or a session she signed out of'
