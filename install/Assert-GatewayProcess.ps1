param([int]$TargetPid,[string]$Executable,[string]$GatewayScript)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
public static class YhwhProcessPath {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr handle,StringBuilder path,uint size,uint flags);
 public static string Canonical(string path) {
  using(var file=File.Open(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) {
   var result=new StringBuilder(32768); uint n=GetFinalPathNameByHandle(file.SafeFileHandle.DangerousGetHandle(),result,32768,0);
   if(n==0||n>=32768)throw new IOException("Cannot resolve process path");
   return result.ToString();
  }
 }
}
'@
$p=Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid"
if(-not $p -or -not $p.ExecutablePath -or [YhwhProcessPath]::Canonical($p.ExecutablePath) -ine [YhwhProcessPath]::Canonical($Executable)){throw 'Gateway process executable mismatch.'}
$match=[regex]::Match($p.CommandLine,'^\s*(?:"[^"]+"|\S+)\s+(?:"([^"]+)"|(\S+))')
$scriptArg=if($match.Groups[1].Success){$match.Groups[1].Value}else{$match.Groups[2].Value}
if(-not $match.Success -or [YhwhProcessPath]::Canonical($scriptArg) -ine [YhwhProcessPath]::Canonical($GatewayScript)){throw 'Gateway process script mismatch.'}
