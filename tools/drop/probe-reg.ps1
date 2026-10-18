# On a running lab: revoke the targets on the browser-process windows (the lost
# state), sniff; then register a logging target on ONE named class, sniff again.
param([int]$ProcId,[string]$Class="Chrome_RenderWidgetHostHWND",[string]$Log)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -Path "$PSScriptRoot\ole.cs"
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class RG {
 public delegate bool EP(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EP p, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EP e, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
 public static string C(IntPtr h){var s=new StringBuilder(256);GetClassName(h,s,256);return s.ToString();}
 public static IntPtr Find(uint pid){IntPtr f=IntPtr.Zero;EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);var s=new StringBuilder(256);GetWindowText(h,s,256);if(p==pid&&IsWindowVisible(h)&&s.ToString().StartsWith("Volery")){f=h;return false;}return true;},IntPtr.Zero);return f;}
 public static List<IntPtr> All(IntPtr t){var l=new List<IntPtr>();EnumChildWindows(t,(h,x)=>{l.Add(h);return true;},IntPtr.Zero);return l;}
}
"@
[Tgt]::Log=$Log; [void][N]::OleInitialize([IntPtr]::Zero)
$top=[RG]::Find($ProcId); if($top -eq [IntPtr]::Zero){ "no lab window"; exit 1 }
[void][RG]::SetWindowPos($top,[IntPtr](-1),300,150,1000,700,0x40)
$me=[Diagnostics.Process]::GetCurrentProcess().Id
foreach($h in [RG]::All($top)){ $p=0; [void][RG]::GetWindowThreadProcessId($h,[ref]$p); if($p -ne $ProcId){ $r=[N]::RevokeDragDrop($h); Add-Content $Log ("revoke {0} -> 0x{1:x}" -f [RG]::C($h),$r) } }
powershell -NoProfile -File "$PSScriptRoot\tree.ps1" -ProcId $ProcId | Add-Content $Log
Add-Content $Log "== sniff, lost state"
$o=Join-Path $env:TEMP "volery-drop-sniff.out"; $probeFile=Join-Path $env:TEMP "volery-drop-probe.txt"; if(-not (Test-Path $probeFile)){ Set-Content $probeFile "a file to drag" }
function Sniff { Remove-Item $o -ErrorAction SilentlyContinue; $s=Start-Process powershell -PassThru -ArgumentList '-NoProfile','-STA','-File',"$PSScriptRoot\sniff.ps1",'-X',800,'-Y',500,'-Path',$probeFile,'-Out',$o
  while(-not $s.HasExited){ [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 10 }
  Get-Content $o -ErrorAction SilentlyContinue | Select-Object -Unique | ForEach-Object { if($_ -notmatch 'under [0-9]{1,2},'){ Add-Content $Log $_ } } }
Sniff
foreach($h in [RG]::All($top)){ if([RG]::C($h) -eq $Class){ $r=[N]::RegisterDragDrop($h,(New-Object Tgt $Class,1)); Add-Content $Log ("register {0} -> 0x{1:x}" -f $Class,$r) } }
Add-Content $Log "== sniff, target on $Class only"
Sniff
[void][RG]::SetWindowPos($top,[IntPtr](-2),0,0,0,0,0x43)
