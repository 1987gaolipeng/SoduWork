param([Parameter(Mandatory=$true)][string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class SoduWorkNativeOverlayProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int X,Y,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int size; public RECT monitor,work; public uint flags; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h,uint command);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h,uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr h,ref MONITORINFO info);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
}
'@
# Query real physical pixels instead of PowerShell's default DPI virtualization.
[void][SoduWorkNativeOverlayProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
function Publish([string]$Name, $Value) {
  $file = Join-Path $FixtureRoot $Name
  [IO.File]::WriteAllText(($file + '.next'), (ConvertTo-Json -InputObject $Value -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
  [IO.File]::Move(($file + '.next'), $file)
}
$form = [Windows.Forms.Form]::new()
$form.Text = 'SoduWork isolated native desktop verification'
$form.Size = [Drawing.Size]::new(680, 420)
$form.StartPosition = 'CenterScreen'
$form.KeyPreview = $true
$form.BackColor = [Drawing.Color]::FromArgb(245,247,250)
$button = [Windows.Forms.Button]::new()
$button.Text = 'Isolated click-through target'
$button.Size = [Drawing.Size]::new(300,80)
$button.Location = [Drawing.Point]::new(180,150)
$form.Controls.Add($button)
$script:clicks = 0; $script:escapes = 0; $script:last = 0
$button.add_Click({ $script:clicks++ })
$form.add_KeyDown({ if ($_.KeyCode -eq [Windows.Forms.Keys]::Escape) { $script:escapes++ } })
$oldCursor = [SoduWorkNativeOverlayProbe+POINT]::new()
[void][SoduWorkNativeOverlayProbe]::GetCursorPos([ref]$oldCursor)
function Assert-Foreground {
  if ([SoduWorkNativeOverlayProbe]::GetForegroundWindow() -ne $form.Handle) { throw 'Fixture is not foreground; no input sent' }
}
$timer = [Windows.Forms.Timer]::new(); $timer.Interval = 30
$timer.add_Tick({
  [void][SoduWorkNativeOverlayProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
  $file = Join-Path $FixtureRoot 'request.json'
  if (-not [IO.File]::Exists($file)) { return }
  try { $request = ConvertFrom-Json ([IO.File]::ReadAllText($file)) } catch { return }
  if ($request.id -le $script:last) { return }
  $script:last = $request.id
  $result = @{ ok=$true }
  try {
    switch ($request.action) {
      'focus' { [void][SoduWorkNativeOverlayProbe]::ShowWindow($form.Handle,5); $form.Activate(); [void][SoduWorkNativeOverlayProbe]::SetForegroundWindow($form.Handle); Assert-Foreground }
      'state' { $result.clicks=$script:clicks; $result.escapes=$script:escapes }
      'inspect' {
        $script:overlayHandles = @($request.overlays | ForEach-Object { [long]$_.handle })
        $z = @{}; $h = [SoduWorkNativeOverlayProbe]::GetTopWindow([IntPtr]::Zero); $i=0
        while ($h -ne [IntPtr]::Zero -and $i -lt 10000) { $z[$h.ToInt64().ToString()]=$i; $i++; $h=[SoduWorkNativeOverlayProbe]::GetWindow($h,2) }
        $result.foregroundIsFixture = [SoduWorkNativeOverlayProbe]::GetForegroundWindow() -eq $form.Handle
        $result.fixtureOrder = $z[$form.Handle.ToInt64().ToString()]
        $result.fixtureVisible = [SoduWorkNativeOverlayProbe]::IsWindowVisible($form.Handle)
        $result.fixtureStyle = [SoduWorkNativeOverlayProbe]::GetWindowLong($form.Handle,-20)
        $result.overlays = @($request.overlays | ForEach-Object {
          $handle=[IntPtr]::new([long]$_.handle); $rect=[SoduWorkNativeOverlayProbe+RECT]::new()
          [void][SoduWorkNativeOverlayProbe]::GetWindowRect($handle,[ref]$rect)
          $monitor=[SoduWorkNativeOverlayProbe+MONITORINFO]::new();$monitor.size=[Runtime.InteropServices.Marshal]::SizeOf($monitor)
          [void][SoduWorkNativeOverlayProbe]::GetMonitorInfo([SoduWorkNativeOverlayProbe]::MonitorFromWindow($handle,2),[ref]$monitor)
          $style=[SoduWorkNativeOverlayProbe]::GetWindowLong($handle,-20)
          @{bounds=@{x=$rect.X;y=$rect.Y;width=$rect.Right-$rect.X;height=$rect.Bottom-$rect.Y};
            monitor=@{x=$monitor.monitor.X;y=$monitor.monitor.Y;width=$monitor.monitor.Right-$monitor.monitor.X;height=$monitor.monitor.Bottom-$monitor.monitor.Y};
            visible=[SoduWorkNativeOverlayProbe]::IsWindowVisible($handle); dpi=[SoduWorkNativeOverlayProbe]::GetDpiForWindow($handle);
            topmost=($style-band 8)-ne 0; noActivate=($style-band 0x08000000)-ne 0; transparent=($style-band 0x20)-ne 0;
            order=$z[$_.handle]}
        })
      }
      'click' {
        Assert-Foreground
        $point=$button.PointToScreen([Drawing.Point]::new(100,40)); $native=[SoduWorkNativeOverlayProbe+POINT]::new(); $native.X=$point.X; $native.Y=$point.Y
        $hit=[SoduWorkNativeOverlayProbe]::WindowFromPoint($native)
        $hitRoot=[SoduWorkNativeOverlayProbe]::GetAncestor($hit,2)
        # WindowFromPoint can return an owned WS_EX_TRANSPARENT overlay even
        # though native mouse dispatch must pass through it. Never input over
        # any unrelated window; the real click assertion checks dispatch next.
        if ($hitRoot -ne $form.Handle -and $script:overlayHandles -notcontains $hitRoot.ToInt64()) {
          $r=[SoduWorkNativeOverlayProbe+RECT]::new(); [void][SoduWorkNativeOverlayProbe]::GetWindowRect($button.Handle,[ref]$r)
          [uint32]$hitPid=0; [void][SoduWorkNativeOverlayProbe]::GetWindowThreadProcessId($hitRoot,[ref]$hitPid)
          $index=0;$h=[SoduWorkNativeOverlayProbe]::GetTopWindow([IntPtr]::Zero);$hitOrder=-1;$ownOrder=-1
          while ($h -ne [IntPtr]::Zero -and $index -lt 10000) {if($h-eq$hitRoot){$hitOrder=$index};if($h-eq$form.Handle){$ownOrder=$index};$index++;$h=[SoduWorkNativeOverlayProbe]::GetWindow($h,2)}
          throw ('Click is not over fixture; no input sent; point=' + $point + '; button=' + ($r|ConvertTo-Json -Compress) + '; hitPid=' + $hitPid + '; fixturePid=' + $PID + '; hitOrder=' + $hitOrder + '; fixtureOrder=' + $ownOrder)
        }
        $result.before=$script:clicks
        [void][SoduWorkNativeOverlayProbe]::SetCursorPos($point.X,$point.Y)
        [SoduWorkNativeOverlayProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
        [SoduWorkNativeOverlayProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
      }
      'escape' { Assert-Foreground; [SoduWorkNativeOverlayProbe]::keybd_event(27,0,0,[UIntPtr]::Zero); [SoduWorkNativeOverlayProbe]::keybd_event(27,0,2,[UIntPtr]::Zero) }
      'exit' { $form.Close() }
      default { throw 'Unknown fixture command' }
    }
  } catch { $result=@{error=$_.Exception.Message} }
  Publish ('response-' + $request.id + '.json') $result
})
$form.add_Shown({ $timer.Start(); Publish 'ready.json' @{pid=$PID} })
try { [Windows.Forms.Application]::Run($form) }
finally { $timer.Stop();$timer.Dispose();$form.Dispose();[void][SoduWorkNativeOverlayProbe]::SetCursorPos($oldCursor.X,$oldCursor.Y) }
