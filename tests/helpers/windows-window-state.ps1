param([Parameter(Mandatory=$true)][long]$Handle,[Parameter(Mandatory=$true)][string]$IconOutput)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
public static class AiroomWindowState {
  [StructLayout(LayoutKind.Sequential)] public struct Key {
    public Guid format; public uint id;
    public Key(uint value){format=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");id=value;}
  }
  [StructLayout(LayoutKind.Explicit,Size=24)] public struct Value {
    [FieldOffset(0)] public ushort type;
    [FieldOffset(8)] public IntPtr text;
  }
  [ComImport,Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface Store {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index,out Key key);
    [PreserveSig] int GetValue(ref Key key,out Value value);
    [PreserveSig] int SetValue(ref Key key,ref Value value);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr window,ref Guid iid,out Store store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref Value value);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr w,IntPtr l);
  public static string Property(long window,uint id){
    Guid iid=typeof(Store).GUID;Store store;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(new IntPtr(window),ref iid,out store));
    var key=new Key(id);Value value;
    try {Marshal.ThrowExceptionForHR(store.GetValue(ref key,out value));try{return value.type==31?Marshal.PtrToStringUni(value.text):"";}finally{PropVariantClear(ref value);}}
    finally{Marshal.ReleaseComObject(store);}
  }
  public static bool SaveIcon(long window,string output){
    var handle=SendMessage(new IntPtr(window),0x007F,new IntPtr(1),IntPtr.Zero);
    if(handle==IntPtr.Zero)return false;
    using(var icon=(Icon)Icon.FromHandle(handle).Clone())using(var bitmap=icon.ToBitmap())bitmap.Save(output,System.Drawing.Imaging.ImageFormat.Png);
    return true;
  }
}
'@
[pscustomobject]@{
  appId=[AiroomWindowState]::Property($Handle,5)
  relaunchCommand=[AiroomWindowState]::Property($Handle,2)
  relaunchIcon=[AiroomWindowState]::Property($Handle,3)
  relaunchName=[AiroomWindowState]::Property($Handle,4)
  hasWindowIcon=[AiroomWindowState]::SaveIcon($Handle,$IconOutput)
} | ConvertTo-Json -Compress
