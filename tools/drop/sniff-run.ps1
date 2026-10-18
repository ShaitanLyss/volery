param([int]$X,[int]$Y,[string]$Path,[string]$Fmt="hdrop")
$o=(Join-Path $env:TEMP "volery-drop-sniff.out"); Remove-Item $o -ErrorAction SilentlyContinue
$p=Start-Process powershell -PassThru -ArgumentList '-NoProfile','-STA','-File',"$PSScriptRoot\sniff.ps1",'-X',$X,'-Y',$Y,'-Path',$Path,'-Fmt',$Fmt,'-Out',$o
if(-not $p.WaitForExit(90000)){ 'TIMEOUT'; Stop-Process -Id $p.Id }
Get-Content $o -ErrorAction SilentlyContinue
