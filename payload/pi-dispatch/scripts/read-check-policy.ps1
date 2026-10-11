param([Parameter(Mandatory=$true)][string]$PolicyPath)
$ErrorActionPreference='Stop'
# Host-only, fixed reviewed script. No model-supplied commands or paths reach it.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class YhwhPolicyReader {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr sa,uint cd,uint f,IntPtr t);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder b,uint n,uint f);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int c,byte[] b,uint n);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetDriveType(string p);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformation(string p,StringBuilder name,uint nc,out uint serial,out uint max,out uint flags,StringBuilder system,uint sc);
  [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle h,int type,uint wanted,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint attr,cl,ch,al,ah,wl,wh,volume,sizeHigh,sizeLow,links,indexHigh,indexLow; }
  static void Fail(string s){throw new InvalidDataException("CHECK_POLICY_"+s);}
  static readonly string ti="S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
  static bool Trusted(string sid,string me,bool owner){return sid==me||sid=="S-1-5-18"||sid=="S-1-5-32-544"||(owner&&sid==ti);}
  static uint Map(uint m){
    if((m&0x02000000)!=0||(m&0x0ce00000)!=0)Fail("ACE_MASK");
    uint r=m&0x00ffffff;
    if((m&0x10000000)!=0)r|=0x001f01ff;
    if((m&0x80000000)!=0)r|=0x00120089;
    if((m&0x40000000)!=0)r|=0x00120116;
    if((m&0x20000000)!=0)r|=0x001200a0;
    return r;
  }
  public static void CheckDescriptor(byte[] bytes,bool file,string me){
    var sd=new RawSecurityDescriptor(bytes,0);
    if(sd.Owner==null||!Trusted(sd.Owner.Value,me,true)||sd.DiscretionaryAcl==null)Fail("OWNER_OR_NULL_DACL");
    uint danger=file?0x000d0156u:0x000d0040u;
    foreach(GenericAce raw in sd.DiscretionaryAcl){
      var a=raw as CommonAce;
      if(a==null||a.IsCallback||(a.AceQualifier!=AceQualifier.AccessAllowed&&a.AceQualifier!=AceQualifier.AccessDenied))Fail("ACE_TYPE");
      if((a.AceFlags&AceFlags.InheritOnly)!=0)continue;
      uint mask=Map(unchecked((uint)a.AccessMask));
      // Universal conservative scan: never subtract a Deny or infer group membership.
      if((mask&danger)!=0&&(a.AceQualifier==AceQualifier.AccessDenied||!Trusted(a.SecurityIdentifier.Value,me,false)))Fail("UNTRUSTED_REPLACEMENT_OR_WRITE");
    }
  }
  static byte[] Security(SafeFileHandle h){
    IntPtr o,g,d,s,p;uint e=GetSecurityInfo(h,1,5,out o,out g,out d,out s,out p);
    if(e!=0)Fail("SECURITY_QUERY");
    try{uint n=GetSecurityDescriptorLength(p);if(n==0||n>65536)Fail("SECURITY_SIZE");var b=new byte[n];Marshal.Copy(p,b,0,(int)n);return b;}finally{LocalFree(p);}
  }
  static string Identity(SafeFileHandle h,string expected,bool file){
    var p=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,p,(uint)p.Capacity,0);
    if(n==0||n>=p.Capacity||!String.Equals(p.ToString(),"\\\\?\\"+expected,StringComparison.OrdinalIgnoreCase))Fail("PATH_ALIAS");
    Info i;if(!GetFileInformationByHandle(h,out i)||(i.attr&0x400)!=0||(file?((i.attr&0x10)!=0||i.links!=1||i.sizeHigh!=0||i.sizeLow>131072):((i.attr&0x10)==0)))Fail("ATTRIBUTES_OR_LINKS");
    var id=new byte[24];if(!GetFileInformationByHandleEx(h,18,id,24))Fail("FILE_ID");
    return Convert.ToBase64String(id)+":"+i.sizeLow+":"+i.wh+":"+i.wl+":"+i.links;
  }
  public static byte[] Read(string input){
    if(input==null||input.Length>4096||input.Length<4||!Char.IsLetter(input[0])||input[1]!=':'||(input[2]!='/'&&input[2]!='\\'))Fail("PATH");
    string full=input.Replace('/','\\');
    if(!String.Equals(Path.GetFullPath(full),full,StringComparison.OrdinalIgnoreCase))Fail("PATH");
    foreach(string part in full.Substring(3).Split('\\'))if(part.Length==0||part=="."||part==".."||part.EndsWith(".")||part.EndsWith(" ")||part.IndexOf(':')>=0||part.IndexOf('~')>=0)Fail("PATH");
    string volume=full.Substring(0,3);uint serial,max,flags;var name=new StringBuilder(128);var system=new StringBuilder(128);
    if(GetDriveType(volume)!=3||!GetVolumeInformation(volume,name,128,out serial,out max,out flags,system,128)||system.ToString()!="NTFS")Fail("VOLUME");
    var handles=new List<SafeFileHandle>();var names=new List<string>();var ids=new List<string>();var descriptors=new List<byte[]>();
    string me=WindowsIdentity.GetCurrent().User.Value;
    try{
      string current=volume;names.Add(current);
      string[] parts=full.Substring(3).Split('\\');for(int j=0;j<parts.Length;j++){current=Path.Combine(current,parts[j]);names.Add(current);}
      for(int j=0;j<names.Count;j++){
        bool file=j==names.Count-1;
        var h=CreateFile(names[j],file?0x80020000u:0x00020080u,file?1u:3u,IntPtr.Zero,3,0x00200000u|(file?0u:0x02000000u),IntPtr.Zero);
        if(h.IsInvalid){h.Dispose();Fail("OPEN");}handles.Add(h);
        ids.Add(Identity(h,names[j],file));var sd=Security(h);CheckDescriptor(sd,file,me);descriptors.Add(sd);
      }
      byte[] contents;
      using(var stream=new FileStream(handles[handles.Count-1],FileAccess.Read,4096,false)){
        if(stream.Length>131072)Fail("SIZE");contents=new byte[(int)stream.Length];int pos=0;while(pos<contents.Length){int got=stream.Read(contents,pos,contents.Length-pos);if(got==0)Fail("READ");pos+=got;}
        for(int j=0;j<handles.Count;j++){
          if(Identity(handles[j],names[j],j==handles.Count-1)!=ids[j]||Convert.ToBase64String(Security(handles[j]))!=Convert.ToBase64String(descriptors[j]))Fail("DRIFT");
        }
      }
      return contents;
    }finally{foreach(var h in handles)h.Dispose();}
  }
}
'@
try {
  $bytes=[YhwhPolicyReader]::Read($PolicyPath)
  $sha=[Security.Cryptography.SHA256]::Create()
  try {$hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}
  [ordered]@{canonicalPath=[IO.Path]::GetFullPath($PolicyPath);sha256=$hash;contentBase64=[Convert]::ToBase64String($bytes)}|ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine('CHECK_POLICY_READ_REJECTED')
  exit 2
}
