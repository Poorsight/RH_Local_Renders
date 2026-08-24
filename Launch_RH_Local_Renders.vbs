Option Explicit

Dim shell, fileSystem, root, batchFile, siteUrl, statusUrl, command, attempt, ready
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

root = fileSystem.GetParentFolderName(WScript.ScriptFullName)
batchFile = fileSystem.BuildPath(root, "Start_RH_Local_Renders.bat")
siteUrl = "http://127.0.0.1:5500/"
statusUrl = siteUrl & "api/status"
ready = ServerReady(statusUrl)

If Not ready Then
  command = "cmd.exe /c """ & batchFile & """ --no-browser"
  shell.Run command, 0, False
  For attempt = 1 To 80
    WScript.Sleep 250
    ready = ServerReady(statusUrl)
    If ready Then Exit For
  Next
End If

If ready Then
  shell.Run siteUrl, 1, False
Else
  shell.Popup "RH Local Renders could not start. Check that Node.js is installed, then try again.", 0, "RH Local Renders", 16
End If

Function ServerReady(endpoint)
  Dim request
  ServerReady = False
  On Error Resume Next
  Set request = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  request.setTimeouts 250, 250, 250, 250
  request.Open "GET", endpoint, False
  request.Send
  If Err.Number = 0 Then ServerReady = (request.Status = 200)
  Set request = Nothing
  Err.Clear
  On Error GoTo 0
End Function
