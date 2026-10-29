# Desktop capture, window control, mouse, and keyboard operations using PowerShell and .NET only.
# Use mouse_event for real input and return a nonzero exit code on errors.
param(
  [Parameter(Position = 0)][string]$Cmd,
  [Parameter(Position = 1)][string]$A1,
  [Parameter(Position = 2)][string]$A2,
  [Parameter(Position = 3)][string]$A3,
  [Parameter(Position = 4)][string]$A4,
  [Parameter(Position = 5)][string]$A5
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'desktop-control.ps1')

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class SoduWorkDesk {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop | Out-Null
[SoduWorkDesk]::SetProcessDPIAware() | Out-Null

$MOVE = 0x0001; $ABS = 0x8000; $VIRTUAL = 0x4000
$LDOWN = 0x0002; $LUP = 0x0004; $RDOWN = 0x0008; $RUP = 0x0010
$MaxTextLength = 4000
$MaxKeyLength = 64
$MaxScreenshotArea = 67108864

function Screen-Size {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  return @([int]$b.Width, [int]$b.Height, [int]$b.Left, [int]$b.Top)
}

function Assert-IntRange([string]$name, [int]$value, [int]$min, [int]$max) {
  if ($value -lt $min -or $value -gt $max) { throw "$name 必须在 $min..$max 范围内" }
}

function Assert-Point([int]$x, [int]$y) {
  $s = Screen-Size
  if ($x -lt $s[2] -or $x -ge ($s[2] + $s[0]) -or $y -lt $s[3] -or $y -ge ($s[3] + $s[1])) {
    throw "坐标 $x,$y 不在可见桌面范围内"
  }
}

function Assert-Rect([int]$x, [int]$y, [int]$w, [int]$h) {
  Assert-IntRange '截图宽度' $w 1 16384
  Assert-IntRange '截图高度' $h 1 16384
  if ([int64]$w * [int64]$h -gt $MaxScreenshotArea) { throw '截图区域过大（最多 64 megapixels）' }
  $s = Screen-Size
  if ($x -lt $s[2] -or $y -lt $s[3] -or $x + $w -gt $s[2] + $s[0] -or $y + $h -gt $s[3] + $s[1]) {
    throw '截图区域必须完整落在虚拟桌面范围内'
  }
}

function Ensure-Parent([string]$path) {
  $full = [System.IO.Path]::GetFullPath($path)
  $parent = [System.IO.Path]::GetDirectoryName($full)
  if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  return $full
}

function Move-To([int]$x, [int]$y) {
  Assert-DesktopControl
  Assert-Point $x $y
  $s = Screen-Size
  $nx = [int](($x - $s[2]) * 65535 / [Math]::Max(1, $s[0] - 1))
  $ny = [int](($y - $s[3]) * 65535 / [Math]::Max(1, $s[1] - 1))
  [SoduWorkDesk]::mouse_event($MOVE -bor $ABS -bor $VIRTUAL, $nx, $ny, 0, [IntPtr]::Zero)
  Wait-DesktopControl 60
}

function Do-Click([int]$x, [int]$y, [string]$btn = 'l', [int]$times = 1) {
  Assert-IntRange '点击次数' $times 1 2
  if ($btn -notin @('l', 'r')) { throw '鼠标按键必须是 l 或 r' }
  Move-To $x $y
  for ($i = 0; $i -lt $times; $i++) {
    Assert-DesktopControl
    if ($btn -eq 'r') {
      [SoduWorkDesk]::mouse_event($RDOWN, 0, 0, 0, [IntPtr]::Zero)
      [SoduWorkDesk]::mouse_event($RUP, 0, 0, 0, [IntPtr]::Zero)
    } else {
      [SoduWorkDesk]::mouse_event($LDOWN, 0, 0, 0, [IntPtr]::Zero)
      [SoduWorkDesk]::mouse_event($LUP, 0, 0, 0, [IntPtr]::Zero)
    }
    Wait-DesktopControl 90
  }
}

function Read-JsonBatch([string]$source) {
  $json = if (-not $source -or $source -eq 'stdin') {
    [Console]::In.ReadToEnd()
  } else {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'batch JSON file not found' }
    Get-Content -LiteralPath $source -Raw
  }
  if (-not $json.Trim()) { throw 'batch is empty' }
  $parsed = ConvertFrom-Json -InputObject $json
  if ($parsed -isnot [System.Array]) { throw 'batch 必须是 JSON 数组' }
  $steps = @($parsed)
  if ($steps.Count -lt 1 -or $steps.Count -gt 50) { throw 'batch must contain 1..50 actions' }
  return $steps
}

function Invoke-Batch([string]$source) {
  $steps = Read-JsonBatch $source
  $done = 0
  foreach ($step in $steps) {
    if ($null -eq $step) { throw 'batch action cannot be null' }
    Assert-DesktopControl
    $action = [string]$step.cmd
    if (-not $action) { throw 'batch action cmd is required' }
    switch ($action) {
      'wait' {
        $ms = 0
        if ($null -eq $step.ms -or -not [int]::TryParse([string]$step.ms, [ref]$ms)) { throw 'wait.ms must be an integer' }
        Assert-IntRange 'wait.ms' $ms 0 5000
        Wait-DesktopControl $ms
      }
      'move' { Move-To ([int]$step.x) ([int]$step.y) }
      'click' { Do-Click ([int]$step.x) ([int]$step.y) 'l' 1 }
      'dblclick' { Do-Click ([int]$step.x) ([int]$step.y) 'l' 2 }
      'rclick' { Do-Click ([int]$step.x) ([int]$step.y) 'r' 1 }
      'type' {
        $value = [string]$step.text
        if ($value.Length -gt $MaxTextLength) { throw "type action is too long (max $MaxTextLength characters)" }
        Send-DesktopText $value
      }
      'key' {
        $value = [string]$step.keys
        if (-not $value -or $value.Length -gt $MaxKeyLength) { throw "invalid key action (1..$MaxKeyLength characters)" }
        [System.Windows.Forms.SendKeys]::SendWait($value)
      }
      default { throw ('unsupported batch action: ' + $action) }
    }
    $done += 1
  }
  Write-Output ('batch complete: {0} actions' -f $done)
}

$exitCode = 0
try {
  if ($Cmd -in @('focus', 'move', 'click', 'dblclick', 'rclick', 'type', 'key', 'batch')) {
    Start-DesktopControl $Cmd
    Assert-DesktopControl
  }
  switch ($Cmd) {
    'shot' {
      $out = if ($A1) { $A1 } else { 'shot.png' }
      $s = Screen-Size
      $x = if ($A2) { [int]$A2 } else { $s[2] }
      $y = if ($A3) { [int]$A3 } else { $s[3] }
      $w = if ($A4) { [int]$A4 } else { $s[0] }
      $h = if ($A5) { [int]$A5 } else { $s[1] }
      Assert-Rect $x $y $w $h
      $out = Ensure-Parent $out
      $bmp = New-Object System.Drawing.Bitmap $w, $h
      try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try { $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h)); $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) }
        finally { $g.Dispose() }
      } finally { $bmp.Dispose() }
      Write-Output ("已截图 {0} （{1}x{2} @ {3},{4}）" -f $out, $w, $h, $x, $y)
    }
    'windows' {
      $fg = [SoduWorkDesk]::GetForegroundWindow()
      $list = New-Object System.Collections.ArrayList
      $cb = [SoduWorkDesk+EnumProc] {
        param($h, $p)
        if ([SoduWorkDesk]::IsWindowVisible($h)) {
          $sb = New-Object System.Text.StringBuilder 512
          [SoduWorkDesk]::GetWindowTextW($h, $sb, 512) | Out-Null
          $t = $sb.ToString()
          if ($t.Trim()) {
            $r = New-Object SoduWorkDesk+RECT
            [SoduWorkDesk]::GetWindowRect($h, [ref]$r) | Out-Null
            $null = $list.Add([PSCustomObject]@{
                Front = ($h -eq $fg); Title = $t
                Pos = ("{0},{1}" -f $r.Left, $r.Top)
                Size = ("{0}x{1}" -f ($r.Right - $r.Left), ($r.Bottom - $r.Top))
              })
          }
        }
        return $true
      }
      [SoduWorkDesk]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
      $list | Where-Object { $_.Size -notmatch '^0x' } | Format-Table -AutoSize | Out-String -Width 200
    }
    'focus' {
      if (-not $A1 -or $A1.Length -gt 256) { throw 'focus 需要 1..256 个字符的窗口标题片段' }
      $hit = $null
      $needle = $A1
      $cb = [SoduWorkDesk+EnumProc] {
        param($h, $p)
        $sb = New-Object System.Text.StringBuilder 512
        [SoduWorkDesk]::GetWindowTextW($h, $sb, 512) | Out-Null
        if ([SoduWorkDesk]::IsWindowVisible($h) -and $sb.ToString().IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $script:hit = $h; return $false }
        return $true
      }
      [SoduWorkDesk]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
      if ($script:hit) {
        Assert-DesktopControl
        [SoduWorkDesk]::ShowWindow($script:hit, 9) | Out-Null
        [SoduWorkDesk]::SetForegroundWindow($script:hit) | Out-Null
        Wait-DesktopControl 250
        Write-Output "已把含「$A1」的窗口调到前面"
      } else { Write-Output "没找到标题含「$A1」的可见窗口" }
    }
    'move' { Move-To ([int]$A1) ([int]$A2); Write-Output "鼠标已移到 $A1,$A2" }
    'click' { Do-Click ([int]$A1) ([int]$A2) 'l' 1; Write-Output "已在 $A1,$A2 左键单击" }
    'dblclick' { Do-Click ([int]$A1) ([int]$A2) 'l' 2; Write-Output "已在 $A1,$A2 双击" }
    'rclick' { Do-Click ([int]$A1) ([int]$A2) 'r' 1; Write-Output "已在 $A1,$A2 右键单击" }
    'type' {
      if (-not $A1 -or $A1.Length -gt $MaxTextLength) { throw "type 需要 1..$MaxTextLength 个字符" }
      Assert-DesktopControl
      Send-DesktopText $A1
      Write-Output "已输入（$($A1.Length) 个字符）"
    }
    'key' {
      if (-not $A1 -or $A1.Length -gt $MaxKeyLength) { throw "key 需要 1..$MaxKeyLength 个字符" }
      Assert-DesktopControl
      [System.Windows.Forms.SendKeys]::SendWait($A1)
      Write-Output "已按 $A1"
    }
    'batch' { Invoke-Batch $A1 }
    default {
      Write-Output 'usage: screen.ps1 shot|windows|focus|move|click|dblclick|rclick|type|key|batch ...'
      Write-Output '先看同目录 SKILL.md 里的护栏：先截图再动手；凭据仅按本次明确授权使用；支付/系统设置/不可逆操作需严格守界。'
    }
  }
} catch {
  $exitCode = 1
  [Console]::Error.WriteLine('失败：' + $_.Exception.Message)
} finally {
  Stop-DesktopControl
}
exit $exitCode
