# What does a browser put on the OLE data object when you drag something out
# of it? The probe behind dropzone.rs's browser formats (sink 4efa4af9).
#
#   powershell -NoProfile -File tools\drop\browsers.ps1 [-Browsers chrome,edge,firefox] [-Out log]
#
# Serves a page with a picture, a link to a PDF and a link to a picture, opens
# it in each browser on a throwaway profile, and drags each one with real
# mouse input (SetCursorPos + mouse_event, DPI-aware) onto browsink.cs, a
# WinForms target in another process that writes down every format offered
# and what each holds at the drop. Then the browser is closed.
#
# Moves the real cursor for about a minute per browser: nobody should be using
# the machine. The sink is topmost, and the drop lands on it, never on a wall.
param([string[]]$Browsers=@("chrome","edge","firefox"),[string]$Out=(Join-Path $env:TEMP "volery-browsink.log"))
$ErrorActionPreference="Stop"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class M {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,int dx,int dy,uint d,UIntPtr e);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int ht,uint f);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
 public delegate bool EW(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EW f, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 public static IntPtr Find(string t){ IntPtr got=IntPtr.Zero; EnumWindows((h,l)=>{ if(!IsWindowVisible(h)) return true; var s=new StringBuilder(512); GetWindowText(h,s,512); var x=s.ToString(); if(x.Contains(t) && !x.Contains("BROWSINK")){ got=h; return false;} return true; }, IntPtr.Zero); return got; }
}
"@
[void][M]::SetProcessDPIAware()

# ---- the page, served over http so the drag is the ordinary web case -------
$root=Join-Path $env:TEMP "volery-browsink-site"; Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $root | Out-Null
$bmp=New-Object Drawing.Bitmap 320,240; $g=[Drawing.Graphics]::FromImage($bmp); $g.Clear([Drawing.Color]::SeaGreen); $g.FillRectangle([Drawing.Brushes]::Orange,160,0,160,120); $g.Dispose(); $bmp.Save((Join-Path $root "pic.png"),[Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
Set-Content (Join-Path $root "doc.pdf") "%PDF-1.4`n% not a real pdf, only its name and type matter here`n%%EOF" -NoNewline
@"
<!doctype html><html><head><title>DRAGPROBE</title><style>body{margin:0;font:6vw sans-serif}
img{display:block;width:100vw;height:44vh;object-fit:cover}
a{display:block;height:24vh;line-height:24vh;text-align:center;background:#eee;border-top:2px solid #999}</style></head>
<body><img src="/pic.png" alt="probe picture"><a href="/doc.pdf">report.pdf link</a><a href="/pic.png">picture link</a></body></html>
"@ | Set-Content (Join-Path $root "index.html")
$port=18765
$srv=Join-Path $root "serve.ts"
@"
Bun.serve({ port: $port, hostname: "127.0.0.1", async fetch(r) {
  const p = new URL(r.url).pathname; const f = Bun.file("$($root -replace '\\','/')" + (p === "/" ? "/index.html" : p));
  return (await f.exists()) ? new Response(f) : new Response("no", { status: 404 }); } });
"@ | Set-Content $srv
$server=Start-Process bun -ArgumentList $srv -PassThru -WindowStyle Hidden

# ---- the sink -------------------------------------------------------------
Remove-Item $Out -ErrorAction SilentlyContinue
$sinkPs=Join-Path $root "sink.ps1"
@"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -Path '$PSScriptRoot\browsink.cs'
[void][Sink]::SetProcessDPIAware(); [Sink]::Log='$Out'
`$f=New-Object Sink; `$f.Location=New-Object Drawing.Point(1600,300); `$f.Size=New-Object Drawing.Size(800,800)
`$t=New-Object Windows.Forms.Timer; `$t.Interval=600000; `$t.Add_Tick({ `$f.Close() }); `$t.Start()
[Windows.Forms.Application]::Run(`$f)
"@ | Set-Content $sinkPs
$sink=Start-Process powershell -PassThru -ArgumentList '-NoProfile','-STA','-File',$sinkPs
Start-Sleep -Seconds 3

function Note($s){ Add-Content $Out $s }
function Dropped(){ (Test-Path $Out) -and ((Get-Content $Out | Select-String DROPPED).Count) }

function Drag($fx,$fy,$label){
  Note "=== $label"
  $before=Dropped
  [void][M]::SetCursorPos($fx,$fy); Start-Sleep -Milliseconds 300
  [M]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 250
  for($i=1;$i -le 6;$i++){ [void][M]::SetCursorPos($fx+$i*4,$fy+$i*3); Start-Sleep -Milliseconds 60 }
  $tx=2000;$ty=700
  for($i=1;$i -le 20;$i++){ [void][M]::SetCursorPos([int]($fx+($tx-$fx)*$i/20),[int]($fy+($ty-$fy)*$i/20)); Start-Sleep -Milliseconds 50 }
  for($i=0;$i -lt 10;$i++){ [void][M]::SetCursorPos($tx+($i%2),$ty); Start-Sleep -Milliseconds 80 }
  [M]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  for($i=0;$i -lt 40 -and (Dropped) -eq $before;$i++){ Start-Sleep -Milliseconds 250 }
  if((Dropped) -eq $before){ Note "(no drop arrived)" }
}

$url="http://127.0.0.1:$port/"
foreach($b in $Browsers){
  $prof=Join-Path $env:TEMP "volery-browsink-$b"; Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $prof | Out-Null
  switch($b){
    "chrome" { $p=Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -PassThru -ArgumentList "--user-data-dir=$prof","--no-first-run","--no-default-browser-check","--new-window",$url }
    "edge"   { $p=Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" -PassThru -ArgumentList "--user-data-dir=$prof","--no-first-run","--no-default-browser-check","--new-window",$url }
    "firefox"{
      @('user_pref("browser.aboutwelcome.enabled", false);','user_pref("browser.shell.checkDefaultBrowser", false);','user_pref("datareporting.policy.dataSubmissionEnabled", false);','user_pref("browser.startup.homepage_override.mstone", "ignore");','user_pref("startup.homepage_welcome_url", "");','user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);') | Set-Content (Join-Path $prof "user.js")
      $p=Start-Process "C:\Program Files\Mozilla Firefox\firefox.exe" -PassThru -ArgumentList "-profile",$prof,"-no-remote","-new-window",$url }
  }
  $h=[IntPtr]::Zero
  for($i=0;$i -lt 60 -and $h -eq [IntPtr]::Zero;$i++){ Start-Sleep -Milliseconds 500; $h=[M]::Find("DRAGPROBE") }
  if($h -eq [IntPtr]::Zero){ Note "=== ${b} no window"; continue }
  [void][M]::ShowWindow($h,9); [void][M]::SetWindowPos($h,[IntPtr]::Zero,0,0,1400,1400,0x40); [void][M]::SetForegroundWindow($h); Start-Sleep -Seconds 2
  $r=New-Object M+RECT; [void][M]::GetWindowRect($h,[ref]$r)
  Note "window $($r.L),$($r.T) $($r.R),$($r.B)"
  $shot=New-Object Drawing.Bitmap 2560,1440; $sg=[Drawing.Graphics]::FromImage($shot); $sg.CopyFromScreen(0,0,0,0,$shot.Size); $sg.Dispose(); $shot.Save((Join-Path $env:TEMP "volery-browsink-$b.png")); $shot.Dispose()
  # Content starts below the toolbars; the page is laid out in viewport units,
  # so aim by fractions of what is left.
  $top=$r.T+200; $hgt=$r.B-$top; $mid=[int](($r.L+$r.R)/2)
  Drag $mid ([int]($top+$hgt*0.22)) "$b image"
  Drag $mid ([int]($top+$hgt*0.56)) "$b pdf link"
  Drag $mid ([int]($top+$hgt*0.80)) "$b picture link"
  Get-Process -Id $p.Id -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process | ? { $_.CommandLine -like "*volery-browsink-$b*" } | % { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}
Stop-Process -Id $sink.Id -ErrorAction SilentlyContinue
Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
Get-Content $Out
