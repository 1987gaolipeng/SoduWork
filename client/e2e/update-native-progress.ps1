param([Parameter(Mandatory=$true)][string]$FixtureRoot, [Parameter(Mandatory=$true)][string]$Observer,
  [Parameter(Mandatory=$true)][string]$Screenshot, [switch]$Baseline, [string]$Lang)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Drawing;
public class SoduWorkProgressWindow {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  public class Control { public long Handle; public string Text,Class,Font; public Rect Bounds; public int Value; public bool Marquee; }
  public class Window { public long Handle; public string Title; public Rect Bounds; public uint Dpi; public Control[] Controls; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc f, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, int flags);
  [DllImport("gdi32.dll",CharSet=CharSet.Unicode)] static extern int GetObject(IntPtr h,int size,byte[] buffer);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string a,string b,int flags);
  [DllImport("shlwapi.dll")] static extern int HashData(byte[] data,int size,out int hash,int hashSize);
  public static System.Threading.Mutex RestrictUiMutex(string root) {
    var bytes=Encoding.Unicode.GetBytes(System.IO.Path.GetFullPath(root).ToLowerInvariant()); int hash; HashData(bytes,bytes.Length,out hash,4);
    var security=new System.Security.AccessControl.MutexSecurity();
    security.SetAccessRuleProtection(true,false);
    security.AddAccessRule(new System.Security.AccessControl.MutexAccessRule(
      System.Security.Principal.WindowsIdentity.GetCurrent().User,
      System.Security.AccessControl.MutexRights.Synchronize,System.Security.AccessControl.AccessControlType.Allow));
    bool created; return new System.Threading.Mutex(false,"Local\\SoduWork.Update."+hash,out created,security);
  }
  public static Window[] Read(int pid) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    var found = new List<Window>();
    EnumWindows((h,p) => { uint owner; GetWindowThreadProcessId(h,out owner);
      if(owner!=(uint)pid || !IsWindowVisible(h)) return true;
      var window=new Window { Handle=h.ToInt64(), Dpi=GetDpiForWindow(h) }; GetWindowRect(h,out window.Bounds);
      var title=new StringBuilder(256); GetWindowText(h,title,256); window.Title=title.ToString();
      var controls=new List<Control>();
      EnumChildWindows(h,(c,q)=> {
        if(!IsWindowVisible(c)) return true;
        var s=new StringBuilder(2048); GetWindowText(c,s,s.Capacity);
        var v=new Control { Handle=c.ToInt64(),Text=s.ToString() }; s.Clear(); GetClassName(c,s,s.Capacity); v.Class=s.ToString();
        var font=new byte[92]; GetObject(SendMessage(c,0x31,IntPtr.Zero,IntPtr.Zero),92,font); v.Font=Encoding.Unicode.GetString(font,28,64).TrimEnd('\0');
        GetWindowRect(c,out v.Bounds);
        if(v.Class=="msctls_progress32") { v.Value=SendMessage(c,0x0408,IntPtr.Zero,IntPtr.Zero).ToInt32(); v.Marquee=(GetWindowLong(c,-16)&8)!=0; }
        controls.Add(v); return true;
      },IntPtr.Zero);
      window.Controls=controls.ToArray(); found.Add(window); return true;
    },IntPtr.Zero);
    return found.ToArray();
  }
  public static void Capture(long handle,string file) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    var h=new IntPtr(handle); Rect r; GetWindowRect(h,out r);
    using(var image=new Bitmap(r.Right-r.Left,r.Bottom-r.Top)) using(var g=Graphics.FromImage(image)) {
      var dc=g.GetHdc(); PrintWindow(h,dc,2); g.ReleaseHdc(dc); image.Save(file,System.Drawing.Imaging.ImageFormat.Png);
    }
  }
  public static void Close(long handle) { SendMessage(new IntPtr(handle),0x10,IntPtr.Zero,IntPtr.Zero); }
}
'@
$lock = $null
$processes = [Collections.Generic.List[Object]]::new()
$checks = [Collections.Generic.List[Object]]::new()
function Start-Observer([bool]$WaitOnly=$true,[string]$Root=$FixtureRoot,[string]$UiLang=$Lang) {
  $env:SODUWORK_UPDATE_ROOT = $Root
  if($UiLang) { $env:SODUWORK_UPDATE_LANG = $UiLang }
  if ($WaitOnly) { $p=Start-Process -FilePath $Observer -ArgumentList '--soduwork-update-wait' -WindowStyle Hidden -PassThru }
  else { $p=Start-Process -FilePath $Observer -WindowStyle Hidden -PassThru }
  Remove-Item Env:SODUWORK_UPDATE_ROOT
  if($UiLang) { Remove-Item Env:SODUWORK_UPDATE_LANG }
  $processes.Add($p)
  return $p
}
function Snapshot([string]$Phase,[string]$Value) {
  [IO.File]::WriteAllText((Join-Path $FixtureRoot '.soduwork-update-phase'),$Phase,[Text.Encoding]::ASCII)
  $next=Join-Path $FixtureRoot '.soduwork-update-progress.next'
  [IO.File]::WriteAllText($next,$Value,[Text.Encoding]::ASCII)
  if(-not [SoduWorkProgressWindow]::MoveFileEx($next,(Join-Path $FixtureRoot '.soduwork-update-progress'),1)) { throw 'Snapshot replacement failed' }
}
function Wait-Progress([int]$Value,[string]$Status,[string]$Title='') {
  $deadline=[DateTime]::UtcNow.AddSeconds(6)
  do {
    if($observerProcess.HasExited) { throw 'Observer exited while lock held' }
    $windows=@([SoduWorkProgressWindow]::Read($observerProcess.Id))
    if($windows.Count -eq 1) {
      $w=$windows[0]; $bars=@($w.Controls | Where-Object Class -eq 'msctls_progress32')
      if($bars.Count -eq 1 -and $bars[0].Value -eq $Value -and ($w.Controls.Text -join '|').Contains($Status)) {
        if($bars[0].Marquee) { throw 'Marquee is not measured progress' }
        if($Title -and $w.Title -ne $Title) { throw ('Expected window title "'+$Title+'", got "'+$w.Title+'"') }
        $width=($w.Bounds.Right-$w.Bounds.Left)*96/$w.Dpi; $height=($w.Bounds.Bottom-$w.Bounds.Top)*96/$w.Dpi
        if($width -gt 490 -or $height -gt 270) { throw "Oversized native window: $width x $height DIP" }
        foreach($c in $w.Controls) {
          if($c.Bounds.Left -lt $w.Bounds.Left -or $c.Bounds.Right -gt $w.Bounds.Right -or $c.Bounds.Bottom -gt $w.Bounds.Bottom) { throw ('Control outside window: '+$c.Text) }
          if($c.Class -eq 'Button') { throw ('Wizard button visible: '+$c.Text) }
        }
        $checks.Add(@{percent=$Value; status=$Status; widthDip=$width; heightDip=$height; dpi=$w.Dpi; bar=$bars[0].Bounds; marquee=$false; fonts=@($w.Controls.Font | Select-Object -Unique)})
        return $w
      }
    }
    Start-Sleep -Milliseconds 80
  } while([DateTime]::UtcNow -lt $deadline)
  throw ('Expected progress '+$Value+': '+($windows | ConvertTo-Json -Depth 5 -Compress))
}
try {
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Screenshot)) | Out-Null
  $lock=[IO.File]::Open((Join-Path $FixtureRoot '.soduwork-update.lock'),'OpenOrCreate','ReadWrite','None')
  Snapshot 'extracting' '12|200|10230'
  if(-not $Baseline) {
    $restricted=[SoduWorkProgressWindow]::RestrictUiMutex($FixtureRoot)
    try {
      $other=Start-Observer
      if(-not $other.WaitForExit(5000) -or $other.ExitCode -ne 0) { throw 'Read-only UI mutex opened a duplicate window' }
      $checks.Add(@{readOnlyMutexDeduplication=$true})
    } finally { $restricted.Dispose() }
  }
  $observerProcess=Start-Observer
  if($Baseline) {
    Start-Sleep -Milliseconds 1200
    $w=@([SoduWorkProgressWindow]::Read($observerProcess.Id))[0]
    [SoduWorkProgressWindow]::Capture($w.Handle,$Screenshot)
    $checks.Add(@{baseline=$true; window=$w})
    $lock.Dispose(); $lock=$null
    if(-not $observerProcess.WaitForExit(5000)) { throw 'Baseline exit timeout' }
  } elseif($Lang -eq 'en-US') {
    <# English UI, environment-variable path: the installer-spawned observer
       reads SODUWORK_UPDATE_LANG; the window title is set at runtime. #>
    $w=Wait-Progress 12 'Installing update' 'SoduWork is updating'
    $labels=@($w.Controls | Where-Object { $_.Text -eq 'Updating SoduWork' })
    if($labels.Count -ne 1) { throw 'English title label missing' }
    $hints=@($w.Controls | Where-Object { $_.Text -eq 'Opens automatically when done. Sessions and files are kept.' })
    if($hints.Count -ne 1) { throw 'English hint label missing' }
    [SoduWorkProgressWindow]::Capture($w.Handle,$Screenshot)
    Snapshot 'verifying' '75|3000|10229'; $null=Wait-Progress 75 'Verifying files' 'SoduWork is updating'
    Snapshot 'activating' '99|0|0'; $null=Wait-Progress 99 'Finishing installation' 'SoduWork is updating'
    Snapshot 'cleaning' '99|0|0'; $null=Wait-Progress 99 'Cleaning up the old version' 'SoduWork is updating'
    Snapshot 'committed' '100|0|0'; $null=Wait-Progress 100 'Update complete' 'SoduWork is updating'
    $shortcut=Start-Observer $false
    $lock.Dispose(); $lock=$null
    if(-not $observerProcess.WaitForExit(5000) -or $observerProcess.ExitCode -ne 0) { throw 'English observer did not finish after commit' }
    if(-not $shortcut.WaitForExit(5000) -or $shortcut.ExitCode -ne 0) { throw 'English shortcut did not finish' }
    $deadline=[DateTime]::UtcNow.AddSeconds(5)
    while(-not (Test-Path (Join-Path $FixtureRoot '.soduwork-versions/test/opened')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if(-not (Test-Path (Join-Path $FixtureRoot '.soduwork-versions/test/opened'))) { throw 'English shortcut did not open payload' }
    Remove-Item -LiteralPath (Join-Path $FixtureRoot '.soduwork-versions/test/opened')
    $checks.Add(@{englishEnvLanguage=$true; englishWindowTitle=$true})
    <# English UI, locale-marker-file path: covers a shortcut opened while the
       installer transaction is still running, without any environment. #>
    [IO.File]::WriteAllText((Join-Path $FixtureRoot '.soduwork-update-locale'),'en-US',[Text.Encoding]::ASCII)
    $lock=[IO.File]::Open((Join-Path $FixtureRoot '.soduwork-update.lock'),'OpenOrCreate','ReadWrite','None')
    Snapshot 'verifying' '40|500|10230'
    $observerProcess=Start-Observer $true $FixtureRoot ''
    $null=Wait-Progress 40 'Verifying files' 'SoduWork is updating'
    $lock.Dispose(); $lock=$null
    if(-not $observerProcess.WaitForExit(5000) -or $observerProcess.ExitCode -ne 0) { throw 'English marker-file observer did not finish' }
    $checks.Add(@{englishLocaleFile=$true})
    <# Locale-registry fallback: ja/ko have no native strings and follow en-US. #>
    [IO.File]::WriteAllText((Join-Path $FixtureRoot '.soduwork-update-locale'),'ja-JP',[Text.Encoding]::ASCII)
    $lock=[IO.File]::Open((Join-Path $FixtureRoot '.soduwork-update.lock'),'OpenOrCreate','ReadWrite','None')
    Snapshot 'extracting' '12|200|10230'
    $observerProcess=Start-Observer $true $FixtureRoot ''
    $null=Wait-Progress 12 'Installing update' 'SoduWork is updating'
    $lock.Dispose(); $lock=$null
    if(-not $observerProcess.WaitForExit(5000) -or $observerProcess.ExitCode -ne 0) { throw 'Japanese fallback observer did not finish' }
    $checks.Add(@{englishJapaneseFallback=$true})
  } else {
    $w=Wait-Progress 12 '正在安装新版本' 'SoduWork 正在更新'
    $labels=@($w.Controls | Where-Object { $_.Text -eq '正在更新 SoduWork' })
    if($labels.Count -ne 1) { throw 'Chinese title label missing' }
    Start-Sleep -Milliseconds 300
    [SoduWorkProgressWindow]::Capture($w.Handle,$Screenshot)
    Start-Sleep -Milliseconds 900
    $null=Wait-Progress 12 '正在安装新版本'
    $duplicate=Start-Observer $true ($FixtureRoot.ToUpperInvariant())
    if(-not $duplicate.WaitForExit(5000) -or $duplicate.ExitCode -ne 0) { throw 'Duplicate observer was not suppressed' }
    $shortcut=Start-Observer $false
    Start-Sleep -Milliseconds 500
    if(@([SoduWorkProgressWindow]::Read($shortcut.Id)).Count -ne 0) { throw 'Shortcut opened a second window' }
    if(Test-Path (Join-Path $FixtureRoot '.soduwork-versions/test/opened')) { throw 'Shortcut launched before commit' }
    $checks.Add(@{singleWindow=$true; shortcutWaits=$true; caseInsensitiveRoot=$true})
    Snapshot 'extracting' '60|8000|10230'; $null=Wait-Progress 60 '正在安装新版本'
    Snapshot 'extracting' '20|200|10230'; Start-Sleep -Milliseconds 350
    $null=Wait-Progress 60 '正在安装新版本'
    Snapshot 'verifying' '75|3000|10229'; $w=Wait-Progress 75 '正在校验文件'
    [SoduWorkProgressWindow]::Close($w.Handle)
    if(-not $observerProcess.WaitForExit(5000)) { throw 'Observer close failed while shortcut waited' }
    $observerProcess=Start-Observer
    $null=Wait-Progress 75 '正在校验文件'
    $checks.Add(@{closedOwnerReopensWithQueuedShortcut=$true})
    Snapshot 'verifying' '100|10229|10229'; Start-Sleep -Milliseconds 350
    $null=Wait-Progress 75 '正在校验文件'
    Snapshot 'unknown-partial' '95|'; Start-Sleep -Milliseconds 350
    $null=Wait-Progress 75 '正在校验文件'
    Snapshot 'verifying' '98|10229|10229'; $null=Wait-Progress 98 '正在校验文件'
    Snapshot 'activating' '99|0|0'; $null=Wait-Progress 99 '正在完成安装'
    Snapshot 'cleaning' '99|0|0'; $null=Wait-Progress 99 '正在整理旧版本'
    Snapshot 'committed' '100|0|0'; $null=Wait-Progress 100 '更新完成'
    $lock.Dispose(); $lock=$null
    if(-not $observerProcess.WaitForExit(5000) -or $observerProcess.ExitCode -ne 0) { throw ('Observer did not finish after commit; exited='+$observerProcess.HasExited+' code='+$observerProcess.ExitCode+' windows='+([SoduWorkProgressWindow]::Read($observerProcess.Id) | ConvertTo-Json -Depth 5 -Compress)) }
    if(-not $shortcut.WaitForExit(5000) -or $shortcut.ExitCode -ne 0) { throw 'Queued shortcut did not finish' }
    $deadline=[DateTime]::UtcNow.AddSeconds(5)
    while(-not (Test-Path (Join-Path $FixtureRoot '.soduwork-versions/test/opened')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if(-not (Test-Path (Join-Path $FixtureRoot '.soduwork-versions/test/opened'))) { throw 'Queued shortcut did not open payload' }
    $checks.Add(@{committed=$true; shortcutOpened=$true})
    $lock=[IO.File]::Open((Join-Path $FixtureRoot '.soduwork-update.lock'),'OpenOrCreate','ReadWrite','None')
    Snapshot 'verifying' '82|4000|10229'
    $observerProcess=Start-Observer
    $w=Wait-Progress 82 '正在校验文件'
    [SoduWorkProgressWindow]::Close($w.Handle)
    if(-not $observerProcess.WaitForExit(5000)) { throw 'Closing observer should close only UI' }
    $observerProcess=Start-Observer
    $null=Wait-Progress 82 '正在校验文件'
    $lock.Dispose(); $lock=$null
    if(-not $observerProcess.WaitForExit(5000)) { throw 'Observer stuck after failed installer released lock' }
    $checks.Add(@{failureNeverComplete=$true; closedWindowReopens=$true})
    Remove-Item -LiteralPath (Join-Path $FixtureRoot '.soduwork-versions/test/opened')
    $lock=[IO.File]::Open((Join-Path $FixtureRoot '.soduwork-update.lock'),'OpenOrCreate','ReadWrite','None')
    Snapshot 'extracting' '12|200|10230'
    $observerProcess=Start-Observer $false
    $w=Wait-Progress 12 '正在安装新版本'
    [SoduWorkProgressWindow]::Close($w.Handle)
    if(-not $observerProcess.WaitForExit(5000)) { throw 'Shortcut window close failed' }
    Start-Sleep -Milliseconds 400
    if(Test-Path (Join-Path $FixtureRoot '.soduwork-versions/test/opened')) { throw 'Closing shortcut wait launched during installation' }
    $checks.Add(@{closedShortcutDoesNotLaunch=$true})
  }
  ConvertTo-Json -InputObject $checks.ToArray() -Depth 6 -Compress
} catch {
  ConvertTo-Json -InputObject $checks.ToArray() -Depth 6 -Compress | Write-Output
  throw
} finally {
  if($lock) { $lock.Dispose() }
  foreach($p in $processes) { if(-not $p.HasExited) { $p.Kill(); $p.WaitForExit() } }
}
