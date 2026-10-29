$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public class SoduWorkLauncherSwapObserver {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFileAttributesW(string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public class Sample { public int AttributeError,OpenError;public long ElapsedTicks; }
  public class Result { public int Samples,AttributeMisses,OpenMisses,ExitCode; public long ElapsedMs;public List<Sample> FirstMisses=new List<Sample>(); }
  public static Result Run(string exe,string entry) {
    var result=new Result();var clock=Stopwatch.StartNew();bool running=true;
    var observer=new Thread(()=>{
      while(Volatile.Read(ref running)) {
        uint attr=GetFileAttributesW(entry);int attrError=attr==UInt32.MaxValue?Marshal.GetLastWin32Error():0;
        IntPtr handle=CreateFileW(entry,0x80000000,7,IntPtr.Zero,3,0,IntPtr.Zero);
        int openError=handle==new IntPtr(-1)?Marshal.GetLastWin32Error():0;
        if(openError==0)CloseHandle(handle);
        result.Samples++;if(attrError!=0)result.AttributeMisses++;if(openError!=0)result.OpenMisses++;
        if((attrError!=0||openError!=0)&&result.FirstMisses.Count<20)result.FirstMisses.Add(new Sample {AttributeError=attrError,OpenError=openError,ElapsedTicks=clock.ElapsedTicks});
      }
    });
    observer.Start();
    try {
      using(var child=Process.Start(new ProcessStartInfo(exe) {UseShellExecute=false,CreateNoWindow=true})) {
        if(!child.WaitForExit(60000)) {child.Kill();throw new Exception("Isolated launcher swap timed out");}
        result.ExitCode=child.ExitCode;
      }
    } finally {Volatile.Write(ref running,false);observer.Join();result.ElapsedMs=clock.ElapsedMilliseconds;}
    return result;
  }
}
'@
$entry = $env:SODUWORK_LAUNCHER_TEST_ENTRY
$acl = Get-Acl -LiteralPath $entry
if ($env:SODUWORK_LAUNCHER_TEST_PROTECT -eq '1') {
  $acl.SetAccessRuleProtection($true,$true)
}
# Materialize inherited ACL metadata before taking the exact SDDL baseline.
# Newly created files can lack AI until a same-directory rename recomputes it.
Set-Acl -LiteralPath $entry -AclObject $acl
$before = (Get-Acl -LiteralPath $entry).Sddl
$handle = $null
try {
  if ($env:SODUWORK_LAUNCHER_TEST_LOCK -eq '1') {
    # Deny delete/rename while allowing read; only this exact owned fixture file.
    $handle = [IO.File]::Open($entry,'Open','Read','ReadWrite')
  }
  $result = [SoduWorkLauncherSwapObserver]::Run($env:SODUWORK_LAUNCHER_TEST_EXE,$entry)
  $after = (Get-Acl -LiteralPath $entry).Sddl
  @{result=$result;daclBefore=$before;daclAfter=$after} | ConvertTo-Json -Depth 6 -Compress
} finally {if($handle){$handle.Dispose()}}
