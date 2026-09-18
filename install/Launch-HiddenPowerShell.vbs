Option Explicit
' GUI-subsystem parent: hide the console at process creation, before PowerShell starts.
If WScript.Arguments.Count <> 2 Then WScript.Quit 64
Dim exe, script, shell, command, result
exe = WScript.Arguments(0)
script = WScript.Arguments(1)
If InStr(exe, Chr(34)) > 0 Or InStr(script, Chr(34)) > 0 Then WScript.Quit 64
Set shell = CreateObject("WScript.Shell")
command = Chr(34) & exe & Chr(34) & " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File " & Chr(34) & script & Chr(34)
result = shell.Run(command, 0, True)
WScript.Quit result
