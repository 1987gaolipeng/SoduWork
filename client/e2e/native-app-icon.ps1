param([long]$WindowHandle, [string]$OutputFile, [string]$Executable)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class SoduWorkIconProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Key { public Guid format; public uint id; }
  [StructLayout(LayoutKind.Explicit, Size=24)] public struct Value {
    [FieldOffset(0)] public ushort type;
    [FieldOffset(8)] public IntPtr pointer;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface Store {
    void GetCount(out uint count);
    void GetAt(uint index, out Key key);
    void GetValue(ref Key key, out Value value);
    void SetValue(ref Key key, ref Value value);
    void Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid id, out Store store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref Value value);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  public static string Property(long handle, uint id) {
    var iid = typeof(Store).GUID; Store store;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(new IntPtr(handle), ref iid, out store));
    var key = new Key { format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), id = id };
    Value value;
    try {
      store.GetValue(ref key, out value);
      try { return value.type == 31 ? Marshal.PtrToStringUni(value.pointer) : ""; }
      finally { PropVariantClear(ref value); }
    } finally { Marshal.ReleaseComObject(store); }
  }
  public static void Save(long handle, string target) {
    var icon = SendMessage(new IntPtr(handle), 0x7F, new IntPtr(1), IntPtr.Zero);
    if (icon == IntPtr.Zero) throw new Exception("Window has no native large icon");
    using (var bitmap = Icon.FromHandle(icon).ToBitmap()) bitmap.Save(target, System.Drawing.Imaging.ImageFormat.Png);
  }
}
'@
[SoduWorkIconProbe]::Save($WindowHandle, $OutputFile)
if ($Executable) {
  $resourceIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($Executable)
  try {
    $bitmap = $resourceIcon.ToBitmap()
    try { $bitmap.Save((Join-Path (Split-Path -Parent $OutputFile) 'executable-icon.png')) }
    finally { $bitmap.Dispose() }
  } finally { $resourceIcon.Dispose() }
}
@{ appId = [SoduWorkIconProbe]::Property($WindowHandle, 5); icon = [SoduWorkIconProbe]::Property($WindowHandle, 3); command = [SoduWorkIconProbe]::Property($WindowHandle, 2) } | ConvertTo-Json -Compress
