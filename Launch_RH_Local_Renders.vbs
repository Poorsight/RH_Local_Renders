Option Explicit

Dim fileSystem, application, root, launcher, arguments
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set application = CreateObject("Shell.Application")

root = fileSystem.GetParentFolderName(WScript.ScriptFullName)
launcher = fileSystem.BuildPath(root, "Launch_RH_Local_Renders.ps1")
arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & launcher & """"
application.ShellExecute "powershell.exe", arguments, root, "open", 0
