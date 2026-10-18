# Which IDropTarget does OLE pick when the window under the cursor has none?
# -Mode same     : form F (target) > panel C > panel G, drag over G
# -Mode cross    : F (target) > C > window owned by ANOTHER process (no target), drag over it
# -Mode crossreg : as cross, and P registers a target on Q's window itself
# -Mode refuse   : C has a target that answers DROPEFFECT_NONE, drag over G
param([string]$Mode="same",[string]$Log)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -Path "$PSScriptRoot\ole.cs"
[Tgt]::Log=$Log
[void][N]::OleInitialize([IntPtr]::Zero)
$f=New-Object Windows.Forms.Form; $f.Text="OLEPROBE"; $f.StartPosition='Manual'; $f.Location=New-Object Drawing.Point(300,150); $f.Size=New-Object Drawing.Size(1000,700); $f.BackColor='Gray'; $f.TopMost=$true
$c=New-Object Windows.Forms.Panel; $c.Dock='Fill'; $c.BackColor='DarkGray'; if($Mode -ne 'direct'){ $f.Controls.Add($c) }
$g=New-Object Windows.Forms.Panel; $g.Dock='Fill'; $g.BackColor='Silver'; $c.Controls.Add($g)
$script:q=$null
$f.Add_Shown({
  $r=[N]::RegisterDragDrop($f.Handle,(New-Object Tgt "F",1)); Add-Content $Log "register F -> $r"
  if($Mode -eq 'refuse'){ $r=[N]::RegisterDragDrop($c.Handle,(New-Object Tgt "C",0)); Add-Content $Log "register C(refuse) -> $r" }
  if($Mode -like 'cross*'){
    $hf=Join-Path $env:TEMP "volery-drop-q.hwnd"; Remove-Item $hf -ErrorAction SilentlyContinue
    $script:q=Start-Process powershell -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-STA','-Command',"Add-Type -AssemblyName System.Windows.Forms; `$q=New-Object Windows.Forms.Form; `$q.FormBorderStyle='None'; `$q.BackColor='Blue'; `$q.Add_Shown({ Set-Content '$hf' ([int64]`$q.Handle) }); [Windows.Forms.Application]::Run(`$q)"
    for($i=0;$i -lt 100 -and -not (Test-Path $hf);$i++){ Start-Sleep -Milliseconds 100 }
    $qh=[IntPtr][int64](Get-Content $hf)
    $st=[N]::GetWindowLong($qh,-16); [void][N]::SetWindowLong($qh,-16,($st -band (-bnot 0x80000000)) -bor 0x40000000)
    $p=[N]::SetParent($qh,$g.Handle); [void][N]::MoveWindow($qh,0,0,1000,700,$true)
    Add-Content $Log "Q hwnd $qh pid $($script:q.Id) setparent -> $p"
    if($Mode -eq 'crossreg' -or $Mode -eq 'crossboth'){ $r=[N]::RegisterDragDrop($qh,(New-Object Tgt "Q",1)); Add-Content $Log ("register Q cross-process -> 0x{0:x}" -f $r) }
  }
  Add-Content $Log "READY"
})
$t=New-Object Windows.Forms.Timer; $t.Interval=30000; $t.Add_Tick({ $f.Close() }); $t.Start()
[Windows.Forms.Application]::Run($f)
if($script:q){ Stop-Process -Id $script:q.Id -ErrorAction SilentlyContinue }
