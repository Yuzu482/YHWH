# Trusted Windows x64 launcher: attach the child before it can create descendants.
param([string]$Executable,[string]$ArgumentsBase64,[string]$WorkingDirectory,[int]$ParentPid)
$ErrorActionPreference='Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class YhwhJob {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
  public int cb; public IntPtr reserved,desktop,title; public int x,y,xsize,ysize,xchars,ychars,fill,flags;
  public short show,reserved2; public IntPtr reservedPtr,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int pid,tid; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,IntPtr data,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint timeout);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint rights,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
 static IntPtr Dup(int n) { IntPtr copy; if(!DuplicateHandle(GetCurrentProcess(),GetStdHandle(n),GetCurrentProcess(),out copy,0,true,2)) throw new Exception(); return copy; }
 static string Quote(string s) {
  var b=new StringBuilder("\""); int slashes=0;
  foreach(char c in s) { if(c=='\\'){slashes++;continue;} if(c=='\"'){b.Append('\\',slashes*2+1);b.Append(c);}else {b.Append('\\',slashes);b.Append(c);} slashes=0; }
  b.Append('\\',slashes*2);b.Append('"');return b.ToString();
 }
 public static int Run(string exe,string[] args,string cwd,int parentPid) {
  if(IntPtr.Size!=8) return 125;
  IntPtr job=IntPtr.Zero,parent=IntPtr.Zero,limits=IntPtr.Zero; PI pi=new PI(); SI si=new SI();
  try {
   parent=OpenProcess(0x100000,false,parentPid); if(parent==IntPtr.Zero) return 125;
   job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) return 125;
   limits=Marshal.AllocHGlobal(144); Marshal.Copy(new byte[144],0,limits,144); Marshal.WriteInt32(limits,16,0x2000);
   if(!SetInformationJobObject(job,9,limits,144)) return 125;
   si.cb=Marshal.SizeOf(typeof(SI));si.flags=0x100;si.input=Dup(-10);si.output=Dup(-11);si.error=Dup(-12);
   var command=new StringBuilder(Quote(exe));foreach(string arg in args){command.Append(' ');command.Append(Quote(arg));}
   if(!CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref si,out pi)) return 125;
   if(!AssignProcessToJobObject(job,pi.process)){TerminateProcess(pi.process,125);return 125;}
   if(ResumeThread(pi.thread)==0xffffffff){TerminateProcess(pi.process,125);return 125;}
   uint wait=WaitForMultipleObjects(2,new IntPtr[]{pi.process,parent},false,0xffffffff);
   uint code; if(wait!=0||!GetExitCodeProcess(pi.process,out code)) return 125;
   return unchecked((int)code);
  } finally {
   if(job!=IntPtr.Zero){TerminateJobObject(job,125);CloseHandle(job);}
   foreach(IntPtr h in new IntPtr[]{pi.process,pi.thread,parent,si.input,si.output,si.error})if(h!=IntPtr.Zero)CloseHandle(h);
   if(limits!=IntPtr.Zero)Marshal.FreeHGlobal(limits);
  }
 }
}
'@
$cliArguments=[string[]](ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64))))
exit [YhwhJob]::Run($Executable,$cliArguments,$WorkingDirectory,$ParentPid)
} catch { [Console]::Error.WriteLine('job_object_launcher_failed'); exit 125 }
