using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AiroomWindowsJob {
  const uint CREATE_SUSPENDED=0x00000004, CREATE_NO_WINDOW=0x08000000;
  const uint STARTF_USESTDHANDLES=0x00000100, HANDLE_FLAG_INHERIT=1;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x00002000, SYNCHRONIZE=0x00100000;
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass,SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public uint cb; public string lpReserved,lpDesktop,lpTitle;
    public uint dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;
    public ushort wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public uint dwProcessId,dwThreadId; }
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr data,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool result,string operation) { if(!result) throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
  static string Quote(string value) {
    var text=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='\"') { text.Append('\\',slashes*2+1);text.Append(c);slashes=0;continue; }
      text.Append('\\',slashes);slashes=0;text.Append(c);
    }
    text.Append('\\',slashes*2);return text.Append('"').ToString();
  }
  public static int Run(string command,string[] args,string cwd,uint parentPid) {
    IntPtr job=IntPtr.Zero,parent=IntPtr.Zero,buffer=IntPtr.Zero;
    PROCESS_INFORMATION process=new PROCESS_INFORMATION();
    try {
      parent=OpenProcess(SYNCHRONIZE,false,parentPid);
      Check(parent!=IntPtr.Zero,"Open parent process");
      job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"Create Job");
      var limits=new EXTENDED_LIMIT();limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int size=Marshal.SizeOf(typeof(EXTENDED_LIMIT));buffer=Marshal.AllocHGlobal(size);Marshal.StructureToPtr(limits,buffer,false);
      Check(SetInformationJobObject(job,9,buffer,(uint)size),"Configure Job");
      var start=new STARTUPINFO();start.cb=(uint)Marshal.SizeOf(typeof(STARTUPINFO));start.dwFlags=STARTF_USESTDHANDLES;
      start.hStdInput=GetStdHandle(-10);start.hStdOutput=GetStdHandle(-11);start.hStdError=GetStdHandle(-12);
      Check(SetHandleInformation(start.hStdInput,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT),"Share input");
      Check(SetHandleInformation(start.hStdOutput,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT),"Share output");
      Check(SetHandleInformation(start.hStdError,HANDLE_FLAG_INHERIT,HANDLE_FLAG_INHERIT),"Share errors");
      var line=new StringBuilder(Quote(command));foreach(string arg in args) line.Append(' ').Append(Quote(arg));
      Check(CreateProcess(command,line,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_NO_WINDOW,IntPtr.Zero,cwd,ref start,out process),"Create suspended member");
      if (!AssignProcessToJobObject(job,process.hProcess)) { TerminateProcess(process.hProcess,1);Check(false,"Assign member to Job"); }
      Check(ResumeThread(process.hThread)!=0xffffffff,"Start member");
      uint waited=WaitForMultipleObjects(2,new IntPtr[]{process.hProcess,parent},false,0xffffffff);
      if(waited==0) { uint code;Check(GetExitCodeProcess(process.hProcess,out code),"Read member exit");return unchecked((int)code); }
      if(waited==1) return 130; // Parent gone: closing our sole Job handle kills all members.
      throw new Win32Exception(Marshal.GetLastWin32Error(),"Wait for member");
    } finally {
      if(job!=IntPtr.Zero)CloseHandle(job);
      if(process.hThread!=IntPtr.Zero)CloseHandle(process.hThread);
      if(process.hProcess!=IntPtr.Zero)CloseHandle(process.hProcess);
      if(parent!=IntPtr.Zero)CloseHandle(parent);
      if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);
    }
  }
}
