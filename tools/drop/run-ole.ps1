# Which IDropTarget does OLE pick? The probes behind src-tauri/src/dropzone.rs
# and .claude/rules/attach.md, measured 2026-10-18 on Windows 11 at 150%.
#
#   run-ole.ps1 -Mode same|cross|crossreg|refuse|direct
#       a synthetic tree (probe-ole.ps1) and a drag from another process
#       (sniff.ps1: enters, reads the effect the target answered, CANCELS — it
#       never drops, so it is safe to aim at anything). What each mode found:
#         same     target on the form, unregistered child  -> the form hears it
#         cross    child owned by another process          -> refused
#         crossreg P registers on Q's window               -> P's target hears it
#         refuse   a child target answering NONE           -> stops the walk
#   tree.ps1 -ProcId <skein pid>         the window tree and who has a target
#   labsniff.ps1 -ProcId <lab pid> -Path <file>   sniff a lab wall's page
#   probe-reg.ps1 -ProcId <lab pid> -Log <file>   revoke the browser windows'
#       targets (the lost state), sniff, register one on the render window, sniff
#
# Moves the real cursor. A person using the machine can put a window over the
# target mid-run, and Windows Terminal raises an invisible drop window during any
# drag that takes files — aim off-centre and keep the target topmost.
param([string]$Mode)
$probeFile=Join-Path $env:TEMP "volery-drop-probe.txt"; if(-not (Test-Path $probeFile)){ Set-Content $probeFile "a file to drag" }
$log=(Join-Path $env:TEMP "volery-drop-ole-$Mode.log"); Remove-Item $log -ErrorAction SilentlyContinue
$p=Start-Process powershell -PassThru -ArgumentList '-NoProfile','-STA','-File',"$PSScriptRoot\probe-ole.ps1",'-Mode',$Mode,'-Log',$log
for($i=0;$i -lt 150;$i++){ if((Test-Path $log) -and (Select-String -Path $log -Pattern READY -Quiet)){break}; Start-Sleep -Milliseconds 100 }
Start-Sleep -Milliseconds 500
& "$PSScriptRoot\sniff-run.ps1" -X 800 -Y 500 -Path $probeFile
Stop-Process -Id $p.Id -ErrorAction SilentlyContinue
"--- $Mode"; Get-Content $log
