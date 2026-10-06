Set objArgs = WScript.Arguments
Set WshShell = CreateObject("WScript.Shell")
nodeCmd = "node login-instagram.js """ & objArgs(0) & """ """ & objArgs(1) & """"
WshShell.Run nodeCmd, 0, False
