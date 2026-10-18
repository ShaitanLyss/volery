# Put the lab's main window on top at a known place, sniff (never drops) at its
# middle, put it back. -Path what to drag.
param([int]$ProcId,[string]$Path,[double]$FX=0.5,[double]$FY=0.5)
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class LS {
 public delegate bool EP(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EP p, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
 public static IntPtr Find(uint pid){IntPtr f=IntPtr.Zero;EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);var s=new StringBuilder(256);GetWindowText(h,s,256);if(p==pid&&IsWindowVisible(h)&&s.ToString().StartsWith("Volery")){f=h;return false;}return true;},IntPtr.Zero);return f;}
}
"@
[void][LS]::SetProcessDPIAware(); $top=[LS]::Find($ProcId); [void][LS]::ShowWindow($top,9); if($top -eq [IntPtr]::Zero){ "no lab window"; exit 1 }
[void][LS]::SetWindowPos($top,[IntPtr](-1),0,0,0,0,0x43)
Start-Sleep -Milliseconds 400
$r=New-Object LS+RECT; [void][LS]::GetWindowRect($top,[ref]$r)
$x=[int]($r.L+($r.R-$r.L)*$FX); $y=[int]($r.T+($r.B-$r.T)*$FY)
"lab rect $($r.L),$($r.T),$($r.R),$($r.B) sniff at $x,$y"
& "$PSScriptRoot\sniff-run.ps1" -X $x -Y $y -Path $Path | Where-Object { $_ -notmatch 'under [0-9]{1,3},[0-9]{1,3} .*WindowsForms' } | Select-Object -Unique -Last 3
[void][LS]::SetWindowPos($top,[IntPtr](-2),0,0,0,0,0x43)
