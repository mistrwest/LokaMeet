import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

let agent: ChildProcess | null = null;
let grant = "";
let scriptPath = "";

const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Desk {
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern byte MapVirtualKey(uint uCode, uint uMapType);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(int value);
  public struct POINT { public int X; public int Y; }
  public static int[] Cur() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
  public static void Place(int x, int y) { SetCursorPos(x, y); }
}
"@
$map = @{
  "Enter"=13; "Escape"=27; "Backspace"=8; "Tab"=9; "Space"=32; " "=32;
  "ArrowLeft"=37; "ArrowUp"=38; "ArrowRight"=39; "ArrowDown"=40;
  "Delete"=46; "Home"=36; "End"=35; "PageUp"=33; "PageDown"=34; "Insert"=45;
  "Shift"=16; "Control"=17; "Alt"=18; "Meta"=91; "OS"=91; "CapsLock"=20; "ContextMenu"=93;
}
for ($i=1; $i -le 12; $i++) { $map["F$i"] = 111 + $i }
$script:on = $false
$script:lastInjX = 0
$script:lastInjY = 0
$script:lastInjAt = 0
$script:stillSince = -1
$script:ox = 0
$script:oy = 0
$script:sw = 0
$script:sh = 0
function ScreenXY([double]$nx, [double]$ny, $x, $y, $w, $h) {
  $sw = if ($script:sw -gt 1) { $script:sw } else { [Math]::Max(1, [Desk]::GetSystemMetrics(0)) }
  $sh = if ($script:sh -gt 1) { $script:sh } else { [Math]::Max(1, [Desk]::GetSystemMetrics(1)) }
  $ox = $script:ox
  $oy = $script:oy
  if ($nx -ne $null -and $ny -ne $null) {
    $px = $ox + [int]([Math]::Min([Math]::Max($nx, 0), 1) * ($sw - 1))
    $py = $oy + [int]([Math]::Min([Math]::Max($ny, 0), 1) * ($sh - 1))
    return @($px, $py)
  }
  if ($w -lt 1) { $w = $sw }
  if ($h -lt 1) { $h = $sh }
  $px = $ox + [int](([Math]::Min([Math]::Max([double]$x, 0), $w) / $w) * ($sw - 1))
  $py = $oy + [int](([Math]::Min([Math]::Max([double]$y, 0), $h) / $h) * ($sh - 1))
  return @($px, $py)
}
function LocalMouse {
  $now = [Environment]::TickCount
  $cur = [Desk]::Cur()
  $delta = [Math]::Max([Math]::Abs($cur[0] - $script:lastInjX), [Math]::Abs($cur[1] - $script:lastInjY))
  if (($now - $script:lastInjAt) -lt 70) { return $false }
  if ($delta -gt 8) {
    $script:lastInjX = $cur[0]
    $script:lastInjY = $cur[1]
    $script:stillSince = 0
    return $true
  }
  if ($script:stillSince -eq 0) { $script:stillSince = $now; return $true }
  if ($script:stillSince -gt 0 -and ($now - $script:stillSince) -lt 120) { return $true }
  $script:stillSince = -1
  return $false
}
function Mark {
  $cur = [Desk]::Cur()
  $script:lastInjX = $cur[0]
  $script:lastInjY = $cur[1]
  $script:lastInjAt = [Environment]::TickCount
}
[void][Desk]::SetProcessDpiAwarenessContext(-4)
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $c = $line | ConvertFrom-Json
    if ($c.t -eq "begin") {
      $script:on = $true
      $script:stillSince = -1
      if ($c.sw) { $script:ox = [int]$c.ox; $script:oy = [int]$c.oy; $script:sw = [int]$c.sw; $script:sh = [int]$c.sh }
      Mark
      continue
    }
    if ($c.t -eq "end") { $script:on = $false; continue }
    if (-not $script:on) { continue }
    $motion = $c.t -eq "move" -or $c.t -eq "down" -or $c.t -eq "up" -or $c.t -eq "wheel"
    if ($motion -and (LocalMouse)) { continue }
    if ($c.t -eq "move" -or $c.t -eq "down" -or $c.t -eq "up") {
      $p = ScreenXY $c.nx $c.ny $c.x $c.y $c.w $c.h
      [void][Desk]::SetCursorPos($p[0], $p[1])
      if ($c.t -eq "down") {
        $flag = if ([int]$c.button -eq 2) { 0x0008 } elseif ([int]$c.button -eq 1) { 0x0020 } else { 0x0002 }
        [Desk]::mouse_event($flag, 0, 0, 0, [UIntPtr]::Zero)
      }
      elseif ($c.t -eq "up") {
        $flag = if ([int]$c.button -eq 2) { 0x0010 } elseif ([int]$c.button -eq 1) { 0x0040 } else { 0x0004 }
        [Desk]::mouse_event($flag, 0, 0, 0, [UIntPtr]::Zero)
      }
      Mark
    }
    elseif ($c.t -eq "wheel") {
      $delta = [int]$c.delta
      if ($delta -gt 32767) { $delta = $delta - 65536 }
      [Desk]::mouse_event(0x0800, 0, 0, [uint]$delta, [UIntPtr]::Zero)
    }
    elseif ($c.t -eq "key") {
      $vk = 0
      $name = [string]$c.key
      if ($map.ContainsKey($name)) { $vk = [int]$map[$name] }
      elseif ($name.Length -eq 1) { $vk = [int][char]($name.ToUpper()) }
      if ($vk -ne 0) {
        $scan = [Desk]::MapVirtualKey([uint]$vk, 0)
        $ext = if ($vk -ge 33 -and $vk -le 40) { 1 } else { 0 }
        $flags = if ($c.down) { $ext } else { 2 -bor $ext }
        [Desk]::keybd_event([byte]$vk, [byte]$scan, $flags, [UIntPtr]::Zero)
      }
    }
  } catch {}
}
`;

function writeScript(): string {
  scriptPath = path.join(os.tmpdir(), "lokameet-desk.ps1");
  fs.writeFileSync(scriptPath, script, "utf8");
  return scriptPath;
}

function ensure(): ChildProcess | null {
  if (process.platform !== "win32") return null;
  if (agent && !agent.killed) return agent;
  const file = writeScript();
  agent = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", file], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  agent.on("exit", () => { agent = null; grant = ""; });
  return agent;
}

function send(cmd: Record<string, unknown>): void {
  const proc = ensure();
  if (!proc?.stdin || !proc.stdin.writable) return;
  proc.stdin.write(`${JSON.stringify(cmd)}\n`);
}

export function injectInput(cmd: Record<string, unknown>): void {
  const kind = String(cmd.t || "");
  if (kind === "begin") {
    grant = String(cmd.grant || "ok");
    send({
      t: "begin",
      ox: Number(cmd.ox) || 0,
      oy: Number(cmd.oy) || 0,
      sw: Number(cmd.sw) || 0,
      sh: Number(cmd.sh) || 0,
    });
    return;
  }
  if (kind === "end") {
    grant = "";
    send({ t: "end" });
    return;
  }
  if (!grant) return;
  if (cmd.grant && String(cmd.grant) !== grant) return;
  send(cmd);
}

export function stopInput(): void {
  grant = "";
  if (!agent) return;
  try { agent.stdin?.write(`${JSON.stringify({ t: "end" })}\n`); } catch { /* closed */ }
  try { agent.stdin?.end(); } catch { /* closed */ }
  agent.kill();
  agent = null;
}
