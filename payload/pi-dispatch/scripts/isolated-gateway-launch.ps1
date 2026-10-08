# Trusted Windows host bridge: fixed sibling Node launcher, explicit inherited-handle whitelist.
$ErrorActionPreference = 'Stop'
try {
    if ($args.Count) { throw 'Unexpected arguments' }
    $buffer = New-Object char[] 8193
    $read = [Console]::In.ReadAsync($buffer, 0, $buffer.Length)
    if (-not $read.Wait(10000) -or $read.Result -gt 8192) { throw 'Invalid input' }
    $packet = (-join $buffer[0..($read.Result-1)]) | ConvertFrom-Json
    if ($read.Result -lt 1 -or @($packet.psobject.Properties.Name).Count -ne 5 -or
        @($packet.psobject.Properties.Name | Where-Object {$_ -notin @('nodePath','settingsFile','timeoutMs','outputFile','errorFile')}).Count -or
        $packet.timeoutMs -lt 1000 -or $packet.timeoutMs -gt 30000 -or $packet.timeoutMs % 1) { throw 'Invalid input' }
    foreach ($name in @('nodePath','settingsFile','outputFile','errorFile')) {
        $file = Get-Item -LiteralPath $packet.$name -ErrorAction Stop
        if (-not [IO.Path]::IsPathRooted($packet.$name) -or $file.PSIsContainer -or
            ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid input file' }
    }
    $settingsRoot = [IO.Path]::GetFullPath((Split-Path -Parent $packet.settingsFile))
    foreach ($name in @('outputFile','errorFile')) {
        if ([IO.Path]::GetFullPath((Split-Path -Parent $packet.$name)) -ine $settingsRoot -or
            (Split-Path -Leaf $packet.$name) -notmatch '^gateway-launch-[a-f0-9-]{36}\.(stdout|stderr)\.tmp$') { throw 'Invalid transport file' }
    }
    if ($packet.outputFile -ieq $packet.errorFile) { throw 'Duplicate transport file' }
    $launchId=[regex]::Match((Split-Path -Leaf $packet.outputFile),'^gateway-launch-([a-f0-9-]{36})\.stdout\.tmp$').Groups[1].Value
    if (-not $launchId -or (Split-Path -Leaf $packet.errorFile) -cne ('gateway-launch-'+$launchId+'.stderr.tmp')) { throw 'Transport identity mismatch' }
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class YhwhIsolatedGateway {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI {
  public int cb;public string reserved,desktop,title;public uint x,y,xSize,ySize,xCount,yCount,fill,flags;
  public ushort show,reserved2;public IntPtr reservedPtr,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] struct SIX {public SI startup;public IntPtr attributes;}
 [StructLayout(LayoutKind.Sequential)] struct PI {public IntPtr process,thread;public uint pid,tid;}
 [StructLayout(LayoutKind.Sequential)] struct FI {public uint attributes,creationLow,creationHigh,accessLow,accessHigh,writeLow,writeHigh,serial,sizeHigh,sizeLow,links,indexHigh,indexLow;}
 public sealed class Result {public uint ExitCode;public bool TimedOut;public uint Pid;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string file,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processAttrs,IntPtr threadAttrs,bool inherit,uint flags,IntPtr environment,string cwd,ref SIX startup,out PI process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr handle,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr handle,StringBuilder path,uint size,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr handle,out FI info);
 public static string Canonical(string path) {
  using(var file=File.Open(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
   FI info;if(!GetFileInformationByHandle(file.SafeFileHandle.DangerousGetHandle(),out info)||info.links!=1||(info.attributes&0x400)!=0)throw new IOException("Nonordinary file");
   var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(file.SafeFileHandle.DangerousGetHandle(),b,32768,0);
   if(n==0||n>=32768)throw new IOException("Path resolution failed");return b.ToString();
  }
 }
 static string Quote(string s) {
  if(s.IndexOf('"')>=0||s.EndsWith("\\"))throw new IOException("Invalid argument");return "\""+s+"\"";
 }
 public static Result Run(string exe,string script,string settings,string output,string error,int timeout,string launchId) {
  var handles=new List<IntPtr>();IntPtr list=IntPtr.Zero,values=IntPtr.Zero,env=IntPtr.Zero;PI pi=new PI();bool initialized=false;
  try {
   foreach(var f in new[]{"NUL",output,error}) {
    IntPtr h=CreateFile(f,f=="NUL"?0x80000000u:0x40000000u,7,IntPtr.Zero,3,0,IntPtr.Zero);
    if(h==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());handles.Add(h);
    if(!SetHandleInformation(h,1,1))throw new Win32Exception(Marshal.GetLastWin32Error());
   }
   IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);list=Marshal.AllocHGlobal(size);
   if(!InitializeProcThreadAttributeList(list,1,0,ref size))throw new Win32Exception(Marshal.GetLastWin32Error());initialized=true;
   values=Marshal.AllocHGlobal(IntPtr.Size*3);for(int i=0;i<3;i++)Marshal.WriteIntPtr(values,i*IntPtr.Size,handles[i]);
   if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),values,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());
   var environment=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
   foreach(DictionaryEntry e in Environment.GetEnvironmentVariables())environment[(string)e.Key]=(string)e.Value;
   environment["PI_KETHER_ISOLATED_LAUNCH"]="1";
   environment["PI_KETHER_LAUNCH_ID"]=launchId;
   var block=new StringBuilder();foreach(var e in environment)block.Append(e.Key).Append('=').Append(e.Value).Append('\0');block.Append('\0');env=Marshal.StringToHGlobalUni(block.ToString());
   var si=new SIX();si.startup.cb=Marshal.SizeOf(typeof(SIX));si.startup.flags=0x100;
   si.startup.input=handles[0];si.startup.output=handles[1];si.startup.error=handles[2];si.attributes=list;
   var command=new StringBuilder(Quote(exe)+" "+Quote(script)+" --settings-file "+Quote(settings)+" --timeout-ms "+timeout);
   // No shell or Job breakaway. Only these three handles survive into the fresh launcher.
   if(!CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|0x8,env,Path.GetDirectoryName(script),ref si,out pi))throw new Win32Exception(Marshal.GetLastWin32Error());
   uint waited=WaitForSingleObject(pi.process,(uint)(timeout+10000));bool timedOut=waited==258;
   if(timedOut) {if(!TerminateProcess(pi.process,124)||WaitForSingleObject(pi.process,5000)!=0)throw new IOException("Unconfirmed launcher cleanup");}
   else if(waited!=0)throw new IOException("Launcher wait failed");
   uint code;if(!GetExitCodeProcess(pi.process,out code))throw new Win32Exception(Marshal.GetLastWin32Error());
   return new Result{ExitCode=code,TimedOut=timedOut,Pid=pi.pid};
  } catch {
   if(pi.process!=IntPtr.Zero&&WaitForSingleObject(pi.process,0)==258){TerminateProcess(pi.process,124);WaitForSingleObject(pi.process,5000);}throw;
  } finally {
   if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);
   foreach(var h in handles)CloseHandle(h);if(initialized)DeleteProcThreadAttributeList(list);
   if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);if(values!=IntPtr.Zero)Marshal.FreeHGlobal(values);if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);
  }
 }
}
'@
    $own = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($own.ParentProcessId)"
    if (-not $parent.ExecutablePath -or [YhwhIsolatedGateway]::Canonical($parent.ExecutablePath) -ine
        [YhwhIsolatedGateway]::Canonical($packet.nodePath)) { throw 'Unexpected parent executable' }
    $canonicalRoot=[IO.Path]::GetDirectoryName([YhwhIsolatedGateway]::Canonical($packet.settingsFile))
    foreach ($name in @('outputFile','errorFile')) {
        if ([IO.Path]::GetDirectoryName([YhwhIsolatedGateway]::Canonical($packet.$name)) -ine $canonicalRoot) { throw 'Transport path escape' }
    }
    $launcher = Join-Path $PSScriptRoot 'start-gateway.mjs'
    $result = [YhwhIsolatedGateway]::Run($packet.nodePath,$launcher,$packet.settingsFile,$packet.outputFile,$packet.errorFile,[int]$packet.timeoutMs,$launchId)
    if ($result.TimedOut) { throw 'Native launcher timed out; service cleanup requires reconciliation' }
    exit $result.ExitCode
} catch {
    # Never echo input, environment, token or provider output.
    [Console]::Error.WriteLine('Isolated gateway launcher failed: '+$_.Exception.GetType().Name)
    exit 1
}
