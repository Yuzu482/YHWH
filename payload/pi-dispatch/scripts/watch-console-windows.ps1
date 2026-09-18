param([int]$Seconds=30)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class ConsoleWindows {
  private delegate bool Callback(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  public static string[] Snapshot() {
    var result=new List<string>();
    EnumWindows((hwnd,data)=> {
      if (!IsWindowVisible(hwnd)) return true;
      var name=new StringBuilder(256); GetClassName(hwnd,name,256);
      var kind=name.ToString();
      if (kind=="ConsoleWindowClass" || kind=="CASCADIA_HOSTING_WINDOW_CLASS") {
        uint pid; GetWindowThreadProcessId(hwnd,out pid);
        result.Add(pid+"/"+kind+"/"+hwnd.ToInt64());
      }
      return true;
    },IntPtr.Zero);
    return result.ToArray();
  }
}
'@
$baseline=@([ConsoleWindows]::Snapshot())
$seen=[Collections.Generic.HashSet[string]]::new()
$timer=[Diagnostics.Stopwatch]::StartNew()
Write-Output ('Baseline visible consoles: '+$baseline.Count)
while($timer.Elapsed.TotalSeconds -lt $Seconds) {
    foreach($window in [ConsoleWindows]::Snapshot()) {
        if($window -notin $baseline -and $seen.Add($window)){Write-Output ('New visible console: '+$window)}
    }
    Start-Sleep -Milliseconds 50
}
@{seconds=$Seconds;newVisibleConsoles=$seen.Count;sampleIntervalMs=50} | ConvertTo-Json -Compress
