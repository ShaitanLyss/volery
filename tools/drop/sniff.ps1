# A drag that never drops: enter the window at (X,Y), log what the target answered
# (GiveFeedback's effect) and which window was under the cursor, then CANCEL.
# Safe to aim at a real wall. -Fmt hdrop|text
param([int]$X,[int]$Y,[string]$Path,[string]$Fmt="hdrop",[string]$Out)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class S {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,int dx,int dy,uint d,UIntPtr e);
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
 [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 public static string Under(){POINT p;GetCursorPos(out p);var h=WindowFromPoint(p);var s=new StringBuilder(256);GetClassName(h,s,256);uint pid;GetWindowThreadProcessId(h,out pid);return string.Format("{0},{1} 0x{2:x} {3} pid={4}",p.X,p.Y,(long)h,s,pid);}
}
"@
[void][S]::SetProcessDPIAware(); $sx=40;$sy=40
$f=New-Object Windows.Forms.Form; $f.FormBorderStyle='None'; $f.Width=60;$f.Height=60;$f.StartPosition='Manual';$f.Location=New-Object Drawing.Point(10,10);$f.TopMost=$true;$f.BackColor='Red'
$script:log=@(); $script:fb=0
$f.Add_GiveFeedback({ param($s,$e) $u=[S]::Under(); if($u -ne $script:last){ $script:log+="feedback effect=$($e.Effect) under $u"; $script:last=$u } })
$f.Add_QueryContinueDrag({ param($s,$e) $p=New-Object S+POINT; [void][S]::GetCursorPos([ref]$p); if([Math]::Abs($p.X-$X) -lt 3 -and [Math]::Abs($p.Y-$Y) -lt 3){ $script:fb++ }; if($script:fb -gt 15 -or $script:step -ge 30){ $e.Action='Cancel' } })
$f.Add_MouseDown({
  $do=New-Object Windows.Forms.DataObject
  if($Fmt -eq 'hdrop'){ $c=New-Object Collections.Specialized.StringCollection; $c.Add($Path)|Out-Null; $do.SetFileDropList($c) } else { $do.SetText("hello") }
  $script:eff=$f.DoDragDrop($do,[Windows.Forms.DragDropEffects]::Copy -bor [Windows.Forms.DragDropEffects]::Link)
  $f.Close()
})
$t=New-Object Windows.Forms.Timer; $t.Interval=120; $script:step=0
$t.Add_Tick({
  switch($script:step){
   0 { [S]::SetCursorPos($sx,$sy)|Out-Null; [S]::mouse_event(2,0,0,0,[UIntPtr]::Zero) }
   1 { [S]::SetCursorPos($sx+20,$sy+20)|Out-Null }
   2 { [S]::SetCursorPos($X-30,$Y-30)|Out-Null }
   3 { [S]::SetCursorPos($X-3,$Y-3)|Out-Null }
   default { if($script:step -lt 40){ [S]::SetCursorPos($X+($script:step%2),$Y)|Out-Null } elseif($script:step -eq 45){ [S]::mouse_event(4,0,0,0,[UIntPtr]::Zero); $f.Close() } }
  }
  $script:step++
})
$f.Add_Shown({$t.Start()})
[void]$f.ShowDialog()
# the drag is over (cancelled) before the button comes up, so nothing drops
$script:log += "result $script:eff"
if($Out){ $script:log | Set-Content $Out } else { $script:log }
