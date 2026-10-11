param([Parameter(Mandatory=$true)][string]$Runtime)
$ErrorActionPreference='Stop'
$Runtime=[IO.Path]::GetFullPath($Runtime).TrimEnd('\')
$program=Join-Path $Runtime 'AIROOM.exe'
if (-not (Test-Path -LiteralPath $program -PathType Leaf)) { throw 'AIROOM program is missing; shortcuts were not changed.' }
$appUserModelId=(Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'electron-builder.json') -Raw | ConvertFrom-Json).appId
if ($appUserModelId -ne 'local.airoom.desktop') { throw 'Shortcut and desktop application identities must agree.' }
# WScript.Shell does not expose AppUserModelID. Set it through the Shell property
# store, then notify Explorer about these specific files instead of clearing caches.
if (-not ('AIROOMShortcutProperties' -as [type])) {
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AIROOMShortcutProperties {
  [StructLayout(LayoutKind.Sequential)] public struct PropertyKey {
    public Guid format; public uint id;
    public PropertyKey(uint value) { format=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); id=value; }
  }
  [StructLayout(LayoutKind.Explicit,Size=24)] public struct PropertyValue {
    [FieldOffset(0)] public ushort type;
    [FieldOffset(8)] public IntPtr text;
  }
  [ComImport,Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface PropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index,out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key,out PropertyValue value);
    [PreserveSig] int SetValue(ref PropertyKey key,ref PropertyValue value);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll",CharSet=CharSet.Unicode,PreserveSig=true)]
  static extern int SHGetPropertyStoreFromParsingName(string path,IntPtr context,uint flags,ref Guid iid,out PropertyStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropertyValue value);
  [DllImport("shell32.dll",CharSet=CharSet.Unicode)]
  static extern void SHChangeNotify(uint change,uint flags,string item,IntPtr other);
  public static void Refresh(string path) { SHChangeNotify(0x2000,0x1005,path,IntPtr.Zero); }
  public static void SetIdentity(string path,string appId) {
    Guid iid=typeof(PropertyStore).GUID; PropertyStore store;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(path,IntPtr.Zero,2,ref iid,out store));
    var key=new PropertyKey(5);
    var value=new PropertyValue { type=31,text=Marshal.StringToCoTaskMemUni(appId) };
    try {
      Marshal.ThrowExceptionForHR(store.SetValue(ref key,ref value));
      Marshal.ThrowExceptionForHR(store.Commit());
    } finally { Marshal.FreeCoTaskMem(value.text); Marshal.ReleaseComObject(store); }
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(path,IntPtr.Zero,0,ref iid,out store));
    try {
      PropertyValue read;
      Marshal.ThrowExceptionForHR(store.GetValue(ref key,out read));
      try { if(read.type!=31 || Marshal.PtrToStringUni(read.text)!=appId) throw new InvalidOperationException("Shortcut AppUserModelID verification failed."); }
      finally { PropVariantClear(ref read); }
    } finally { Marshal.ReleaseComObject(store); }
    Refresh(path);
  }
}
'@
}
$shortcutShell=New-Object -ComObject WScript.Shell
$desktop=[Environment]::GetFolderPath('DesktopDirectory')
$programs=Join-Path ([Environment]::GetFolderPath('Programs')) 'AIROOM'
New-Item -ItemType Directory -Force -Path $programs | Out-Null
foreach($shortcutPath in @((Join-Path $desktop 'AIROOM.lnk'),(Join-Path $programs 'AIROOM.lnk'))) {
  $link=$shortcutShell.CreateShortcut($shortcutPath)
  $link.TargetPath=$program
  $link.WorkingDirectory=$Runtime
  $link.Arguments=''
  $link.IconLocation="$program,0"
  $link.Description='AIROOM'
  $link.Save()
  [AIROOMShortcutProperties]::SetIdentity($shortcutPath,$appUserModelId)
}
[AIROOMShortcutProperties]::Refresh($program)
Write-Host "AIROOM desktop and Start menu shortcuts verified: $appUserModelId"

# Remove only duplicate shortcuts whose inspected target is a known AIROOM entry.
$canonical=@((Join-Path $desktop 'AIROOM.lnk'),(Join-Path $programs 'AIROOM.lnk'))
$known=@($program,(Join-Path $env:USERPROFILE '.airoom\AIROOM.exe'),(Join-Path (Split-Path -Parent $PSScriptRoot) 'Start-AIROOM.cmd'))
foreach($base in @($desktop,[Environment]::GetFolderPath('Programs'))) {
  foreach($file in Get-ChildItem -LiteralPath $base -Filter '*AIROOM*.lnk' -File -Recurse -ErrorAction SilentlyContinue) {
    if($canonical -contains $file.FullName){continue}
    $link=$shortcutShell.CreateShortcut($file.FullName)
    if($known -contains $link.TargetPath) {
      Remove-Item -LiteralPath $file.FullName
    }
  }
}
