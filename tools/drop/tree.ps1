param([int]$ProcId,[string]$Title="Volery")
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public class T {
 public delegate bool EP(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EP p, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EP e, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint f);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr h,string s);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int i);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
 public static string Cls(IntPtr h){var s=new StringBuilder(256);GetClassName(h,s,256);return s.ToString();}
 public static string Txt(IntPtr h){var s=new StringBuilder(256);GetWindowText(h,s,256);return s.ToString();}
 public static List<IntPtr> Kids(IntPtr p){var l=new List<IntPtr>();EnumChildWindows(p,(h,x)=>{if(GetAncestor(h,1)==p)l.Add(h);return true;},IntPtr.Zero);return l;}
 public static List<IntPtr> Tops(uint pid){var l=new List<IntPtr>();EnumWindows((h,x)=>{uint p;GetWindowThreadProcessId(h,out p);if(p==pid&&IsWindowVisible(h))l.Add(h);return true;},IntPtr.Zero);return l;}
}
"@
function Show($h,$d){
  $p=0;$tid=[T]::GetWindowThreadProcessId($h,[ref]$p)
  $dt=[T]::GetProp($h,"OleDropTargetInterface"); $mh=[T]::GetProp($h,"OleDropTargetMarshalHwnd")
  $r=New-Object T+RECT;[void][T]::GetWindowRect($h,[ref]$r)
  $st=[T]::GetWindowLong($h,-16); $ex=[T]::GetWindowLong($h,-20)
  "{0}{1} 0x{2:x} pid={3} tid={4} vis={5} drop={6} marsh={7} rect={8},{9},{10},{11} style=0x{12:x} ex=0x{13:x} '{14}'" -f ('  '*$d),[T]::Cls($h),[int64]$h,$p,$tid,[T]::IsWindowVisible($h),($dt -ne [IntPtr]::Zero),($mh -ne [IntPtr]::Zero),$r.L,$r.T,$r.R,$r.B,$st,$ex,[T]::Txt($h)
  foreach($k in [T]::Kids($h)){ Show $k ($d+1) }
}
foreach($t in [T]::Tops($ProcId)){ if([T]::Txt($t) -like "*$Title*"){ Show $t 0 } }
