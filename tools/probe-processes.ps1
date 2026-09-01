# What this wall is actually running, and whether the job objects are holding.
#
# See .claude/rules/processes.md, which is the reasoning; this is the instrument
# that produced its figures on 2026-09-01.
#
#   pwsh tools/probe-processes.ps1              # the census
#   pwsh tools/probe-processes.ps1 -Reap        # also prove KILL_ON_JOB_CLOSE
#   pwsh tools/probe-processes.ps1 -Wmi         # also prove the WMI escape
#
# The two proofs spawn their own throwaway trees and clean up after themselves.
# They touch nothing on the wall.
#
# Ownership is decided by walking ParentProcessId to a root, never by image
# name: a `claude.exe` this studio did not spawn is somebody's terminal, and
# perf.rs's `known` map draws exactly that line. Memory is reported as **private
# commit**, not working set — on a machine that is paging, working set is a
# measure of what happens to be resident and says nothing about what a process
# costs.

[CmdletBinding()]
param(
  [switch]$Reap,
  [switch]$Wmi
)

$ErrorActionPreference = 'Stop'

# ── the census ────────────────────────────────────────────────────────────

$all = @{}
Get-CimInstance Win32_Process | ForEach-Object { $all[[int]$_.ProcessId] = $_ }

$perf = @{}
Get-CimInstance Win32_PerfRawData_PerfProc_Process |
  ForEach-Object { $perf[[int]$_.IDProcess] = $_ }

function Mb($id) {
  if ($perf.ContainsKey([int]$id)) { [math]::Round($perf[[int]$id].PrivateBytes / 1MB, 0) } else { 0 }
}

# Climb until something is recognised. Returns 0 rather than guessing when the
# chain runs into a pid nobody is at any more -- which is precisely the shape a
# leaked process has, and precisely where a parent walk must admit it is blind.
function Ancestor($start, $name) {
  $cur = [int]$start; $seen = @{}
  while ($cur -and $all.ContainsKey($cur) -and -not $seen.ContainsKey($cur)) {
    $seen[$cur] = 1
    $p = $all[$cur]
    if ($p.Name -eq $name) { return [int]$p.ProcessId }
    $cur = [int]$p.ParentProcessId
  }
  return 0
}

function Chain($start) {
  $out = @(); $cur = [int]$start; $seen = @{}
  while ($cur -and $all.ContainsKey($cur) -and -not $seen.ContainsKey($cur)) {
    $seen[$cur] = 1
    $p = $all[$cur]
    $out += ('{0}/{1}' -f $p.Name, $p.ProcessId)
    $cur = [int]$p.ParentProcessId
  }
  if ($cur -and -not $all.ContainsKey($cur)) { $out += ('<gone>/{0}' -f $cur) }
  return ($out -join ' <- ')
}

Write-Output '== studios =='
$studios = Get-CimInstance Win32_Process -Filter "Name='skein.exe' or Name='volery.exe'"
if (-not $studios) { Write-Output '  none running' }
$studios | ForEach-Object {
  '  {0}/{1}  up since {2}' -f $_.Name, $_.ProcessId, $_.CreationDate.ToString('MM-dd HH:mm')
}

Write-Output ''
Write-Output '== per card =='
Write-Output '   card            started  procs  private-MB   node'

$kinds = @('node.exe', 'cmd.exe', 'conhost.exe', 'bash.exe', 'claude.exe', 'chrome.exe')
$groups = @{}
$all.Values | Where-Object { $kinds -contains $_.Name } | ForEach-Object {
  $c = Ancestor $_.ProcessId 'claude.exe'
  if ($c) {
    if (-not $groups.ContainsKey($c)) { $groups[$c] = @() }
    $groups[$c] += $_
  }
}

$totalMb = 0; $totalN = 0
$groups.Keys | Sort-Object { $all[$_].CreationDate } | ForEach-Object {
  $procs = $groups[$_]
  $mb = ($procs | ForEach-Object { Mb $_.ProcessId } | Measure-Object -Sum).Sum
  $nodes = @($procs | Where-Object { $_.Name -eq 'node.exe' }).Count
  $totalMb += $mb; $totalN += $procs.Count
  '   claude/{0,-7} {1}  {2,4}  {3,8} MB  {4,4}' -f `
    $_, $all[$_].CreationDate.ToString('HH:mm'), $procs.Count, $mb, $nodes
}
'   -- {0} cards, {1} processes, {2} MB private commit' -f $groups.Count, $totalN, $totalMb

# Things that look like an agent toolchain but have no studio above them.
#
# This section is a **heuristic and says so**, unlike everything above it. The
# census is proof -- it climbs to a studio, and job membership is what
# `owned_pids` and `kill_process` stand on. Here there is nothing to climb to,
# so the only evidence left is what the command line looks like, which is
# exactly the guess `jobs::Job::pids` argues against relying on.
#
# It is matched on the command line rather than on the image name, and that
# narrowing is the whole difference between a useful list and a useless one. An
# earlier cut of this filtered by image and reported the user's ordinary browser
# -- twelve `chrome.exe`, 1.7 GB, parent long exited, because a browser
# launcher always exits -- alongside three system `conhost.exe`. That is a probe
# that cries leak at a working machine, which is precisely the mistake sink
# 7f011a39 made and this file exists to correct.
Write-Output ''
Write-Output '== possibly stranded (agent-shaped, no studio above them) =='
Write-Output '   heuristic -- matched on command line, NOT proof of ownership'

$agentish = 'playwright|@modelcontextprotocol|mcp-server|\.claude|claude-code|anthropic'
$loose = $all.Values |
  Where-Object { $_.Name -in @('node.exe', 'claude.exe', 'bun.exe') } |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $agentish } |
  Where-Object { -not (Ancestor $_.ProcessId 'skein.exe') -and -not (Ancestor $_.ProcessId 'volery.exe') }

if (-not $loose) {
  Write-Output '   none -- every agent-shaped process roots at a running studio'
} else {
  $looseMb = 0
  $loose | Sort-Object CreationDate | ForEach-Object {
    $looseMb += (Mb $_.ProcessId)
    '   {0}/{1} {2} {3,6} MB  {4}' -f `
      $_.Name, $_.ProcessId, $_.CreationDate.ToString('MM-dd HH:mm'), (Mb $_.ProcessId), (Chain $_.ProcessId)
  }
  '   -- {0} processes, {1} MB' -f @($loose).Count, $looseMb
  Write-Output '   NOTE: a terminal or VS Code session is the ordinary explanation.'
  Write-Output '         Check for a live parent before calling any of this a leak.'
}

$os = Get-CimInstance Win32_OperatingSystem
Write-Output ''
'== machine: {0} MB RAM, {1} MB free; commit {2} of {3} MB ==' -f `
  [math]::Round($os.TotalVisibleMemorySize / 1KB, 0),
  [math]::Round($os.FreePhysicalMemory / 1KB, 0),
  [math]::Round((Get-Counter '\Memory\Committed Bytes').CounterSamples[0].CookedValue / 1MB, 0),
  [math]::Round((Get-Counter '\Memory\Commit Limit').CounterSamples[0].CookedValue / 1MB, 0)

if (-not ($Reap -or $Wmi)) { return }

# ── the two proofs ────────────────────────────────────────────────────────

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JobProbe {
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong r,w,o,rt,wt,ot; }
  [StructLayout(LayoutKind.Sequential)] public struct BASIC {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags; public UIntPtr MinWs, MaxWs;
    public uint ActiveProcessLimit; public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct EXTENDED {
    public BASIC BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateJobObjectW(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr i, uint l);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool inh, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);

  // Exactly what servers.rs's jobs::Job::new sets, and nothing else. Note
  // BREAKAWAY_OK is absent, which is what makes CREATE_BREAKAWAY_FROM_JOB
  // unavailable to anything inside it.
  public const uint KILL_ON_JOB_CLOSE = 0x2000;

  public static IntPtr Make() {
    IntPtr j = CreateJobObjectW(IntPtr.Zero, null);
    var info = new EXTENDED();
    info.BasicLimitInformation.LimitFlags = KILL_ON_JOB_CLOSE;
    int sz = Marshal.SizeOf(info);
    IntPtr p = Marshal.AllocHGlobal(sz);
    Marshal.StructureToPtr(info, p, false);
    SetInformationJobObject(j, 9, p, (uint)sz);   // JobObjectExtendedLimitInformation
    Marshal.FreeHGlobal(p);
    return j;
  }
  public static bool Assign(IntPtr job, uint pid) {
    IntPtr h = OpenProcess(0x0100 | 0x0001, false, pid);   // SET_QUOTA | TERMINATE
    if (h == IntPtr.Zero) return false;
    bool ok = AssignProcessToJobObject(job, h);
    CloseHandle(h);
    return ok;
  }
  public static void Close(IntPtr h) { CloseHandle(h); }
}
'@

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Output 'no node on PATH -- skipping the proofs'; return }
$dir = Join-Path ([IO.Path]::GetTempPath()) ("volery-jobprobe-" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $dir | Out-Null

try {
  if ($Reap) {
    Write-Output ''
    Write-Output '== proof: KILL_ON_JOB_CLOSE reaps a cmd -> node -> cmd -> node chain =='
    # The shape a stdio MCP server really has under a card:
    #   claude.exe <- cmd.exe <- node(npx) <- cmd.exe <- node(cli.js)
    # Only the ROOT is assigned. Everything below has to be caught by
    # inheritance, which is the thing actually under test.
    #
    # .cjs, not .js: a fixture written as .js inside this repo is an ES module
    # (package.json says "type": "module"), so `require` throws and the harness
    # reports "0 alive" -- which looks exactly like a successful reap.
    Set-Content "$dir\inner.cjs" 'setInterval(function(){}, 1e9);'
    Set-Content "$dir\outer.cjs" @"
var cp = require('child_process'), path = require('path');
cp.spawn('cmd.exe', ['/c', $($node | ConvertTo-Json), path.join(__dirname, 'inner.cjs')], { stdio: 'ignore' });
setInterval(function(){}, 1e9);
"@
    Set-Content "$dir\run.cmd" "@echo off`r`n`"$node`" `"$dir\outer.cjs`""

    $job = [JobProbe]::Make()
    $root = Start-Process -FilePath "$dir\run.cmd" -PassThru -WindowStyle Hidden
    $ok = [JobProbe]::Assign($job, [uint32]$root.Id)
    "  root cmd/$($root.Id) assigned: $ok"
    Start-Sleep -Seconds 5

    function Alive {
      @(Get-CimInstance Win32_Process |
        Where-Object { $_.Name -in @('node.exe','cmd.exe') -and $_.CommandLine -match 'outer\.cjs|inner\.cjs' })
    }
    $before = Alive
    "  before close: $($before.Count) alive -> " + (($before | ForEach-Object { "$($_.Name)/$($_.ProcessId)" }) -join ', ')
    if ($before.Count -lt 2) { Write-Output '  !! the chain never started -- this run proves nothing' }

    [JobProbe]::Close($job)
    Start-Sleep -Seconds 3
    $after = Alive
    "  after  close: $($after.Count) alive"
    if ($after.Count -eq 0 -and $before.Count -ge 2) {
      Write-Output '  PASS -- the whole tree went with the handle'
    } else {
      Write-Output '  FAIL -- something outlived the job'
      $after | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
  }

  if ($Wmi) {
    Write-Output ''
    Write-Output '== proof: Win32_Process.Create escapes the job =='
    Set-Content "$dir\idle.cjs" 'setInterval(function(){}, 1e9);'
    $job2 = [JobProbe]::Make()
    $host2 = Start-Process -FilePath $node -ArgumentList "$dir\idle.cjs" -PassThru -WindowStyle Hidden
    [JobProbe]::Assign($job2, [uint32]$host2.Id) | Out-Null
    "  in-job host node/$($host2.Id)"

    $made = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
              -Arguments @{ CommandLine = "$node $dir\idle.cjs" }
    Start-Sleep 2
    $w = Get-CimInstance Win32_Process -Filter "ProcessId=$($made.ProcessId)"
    $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($w.ParentProcessId)"
    "  WMI child node/$($made.ProcessId) -- parent is $($par.Name)/$($par.ProcessId)"

    [JobProbe]::Close($job2)
    Start-Sleep 3
    $hostAlive = [bool](Get-CimInstance Win32_Process -Filter "ProcessId=$($host2.Id)")
    $wmiAlive  = [bool](Get-CimInstance Win32_Process -Filter "ProcessId=$($made.ProcessId)")
    "  in-job host alive after close : $hostAlive"
    "  WMI child   alive after close : $wmiAlive"
    if (-not $hostAlive -and $wmiAlive) {
      Write-Output '  CONFIRMED -- WMI reparents out of the job; such a process is unattributable'
    } else {
      Write-Output '  did not reproduce -- check the run above'
    }
    if ($wmiAlive) { Stop-Process -Id $made.ProcessId -Force -ErrorAction SilentlyContinue }
  }
} finally {
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
}
