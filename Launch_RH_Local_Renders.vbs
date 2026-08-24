Option Explicit

Dim shell, fileSystem, root, batchFile, siteUrl, statusUrl, command, attempt, state
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

root = fileSystem.GetParentFolderName(WScript.ScriptFullName)
batchFile = fileSystem.BuildPath(root, "Start_RH_Local_Renders.bat")
siteUrl = "http://127.0.0.1:5500/"
statusUrl = siteUrl & "api/status"
state = ServerState(statusUrl)

If state = "stale" Then
  command = "powershell.exe -NoProfile -WindowStyle Hidden -Command ""$connection = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 5500 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($connection) { $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $connection.OwningProcess); if ($process.Name -eq 'node.exe' -and $process.CommandLine -match 'server\.cjs') { Stop-Process -Id $connection.OwningProcess -Force } }"""
  shell.Run command, 0, True
  For attempt = 1 To 20
    WScript.Sleep 250
    state = ServerState(statusUrl)
    If state = "offline" Then Exit For
  Next
End If

If state <> "ready" Then
  command = "cmd.exe /d /s /c call """ & batchFile & """ --no-browser"
  shell.Run command, 0, False
  For attempt = 1 To 80
    WScript.Sleep 250
    state = ServerState(statusUrl)
    If state = "ready" Then Exit For
  Next
End If

If state = "ready" Then
  shell.Run siteUrl, 1, False
Else
  shell.Popup "RH Local Renders could not start. Check that Node.js is installed, then try again.", 0, "RH Local Renders", 16
End If

Function ServerState(endpoint)
  Dim request
  ServerState = "offline"
  On Error Resume Next
  Set request = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  request.setTimeouts 250, 250, 250, 250
  request.Open "GET", endpoint, False
  request.Send
  If Err.Number = 0 And request.Status = 200 Then
    If InStr(1, request.responseText, """stale"":false", vbTextCompare) > 0 Then
      ServerState = "ready"
    Else
      ServerState = "stale"
    End If
  End If
  Set request = Nothing
  Err.Clear
  On Error GoTo 0
End Function
