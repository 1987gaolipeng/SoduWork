param()
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SoduWorkResourceProbe {
  [DllImport("user32.dll")] public static extern uint GetGuiResources(IntPtr process, uint flags);
}
'@
[Console]::Out.WriteLine('{"ready":true}')
while ($null -ne ($request = [Console]::ReadLine())) {
  try {
    $query = ConvertFrom-Json -InputObject $request
    $values = @()
    foreach ($processId in $query.ids) {
      $sampled = $null
      try {
        $sampled = [Diagnostics.Process]::GetProcessById([int]$processId)
        $sampled.Refresh()
        $values += [ordered]@{ pid = [int]$processId; handles = $sampled.HandleCount;
          privateBytes = $sampled.PrivateMemorySize64; workingSetBytes = $sampled.WorkingSet64;
          cpuMs = $sampled.TotalProcessorTime.TotalMilliseconds;
          gdi = [SoduWorkResourceProbe]::GetGuiResources($sampled.Handle, 0);
          user = [SoduWorkResourceProbe]::GetGuiResources($sampled.Handle, 1) }
      } catch {
        $values += @{ pid = [int]$processId; exited = $true }
      } finally {
        if ($null -ne $sampled) { $sampled.Dispose() }
      }
    }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ id = $query.id; values = $values } -Depth 4 -Compress))
  } catch {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ error = $_.Exception.Message } -Compress))
  }
}
