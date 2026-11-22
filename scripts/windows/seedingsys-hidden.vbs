' Started by the "SeedingSys" scheduled task at logon (see install-autostart.ps1).
' Runs `node scripts\server.mjs start` with no console window and waits for it,
' so Task Scheduler sees the supervisor as running and can restart it if it fails.
' Argument 0: full path to node.exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
code = sh.Run("""" & WScript.Arguments(0) & """ scripts\server.mjs start", 0, True)
WScript.Quit code
