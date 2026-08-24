[CmdletBinding()]
param(
    [ValidateSet('Check', 'Apply', 'Build', 'Setup')]
    [string]$Action = 'Check',
    [string]$PluginRoot = 'D:\GitHub\rh_unreal_2\Plugins\BatchRender',
    [string]$UnrealProject = 'D:\GitHub\rh_unreal_2\rh_unreal_2.uproject',
    [string]$UnrealRoot = 'D:\Unreal_Engine\UE_5.6'
)

$ErrorActionPreference = 'Stop'
$PatchVersion = 1
$PatchPath = Join-Path $PSScriptRoot '..\integration\batchrender\rh-camera-handoff.patch'
$SourceFiles = @(
    'Source\BatchRenderEditor\Public\JobModel.h',
    'Source\BatchRenderEditor\Private\JobModel.cpp',
    'Source\BatchRender\Private\BatchRender.cpp'
)
$BuildGroups = @(
    @{
        Binary = 'Binaries\Win64\UnrealEditor-BatchRenderEditor.dll'
        Sources = @($SourceFiles[0], $SourceFiles[1])
    },
    @{
        Binary = 'Binaries\Win64\UnrealEditor-BatchRender.dll'
        Sources = @($SourceFiles[0], $SourceFiles[2])
    }
)

function Assert-Inputs {
    if (-not (Test-Path -LiteralPath $PluginRoot -PathType Container)) { throw "BatchRender plugin not found: $PluginRoot" }
    if (-not (Test-Path -LiteralPath $PatchPath -PathType Leaf)) { throw "Bridge patch not found: $PatchPath" }
    foreach ($relative in $SourceFiles) {
        $file = Join-Path $PluginRoot $relative
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "BatchRender source file not found: $file" }
    }
}

function Test-SourceSupport {
    $header = Get-Content -LiteralPath (Join-Path $PluginRoot $SourceFiles[0]) -Raw
    return $header.Contains('CameraFocalHandoffVersion = 1')
}

function Test-BinariesCurrent {
    $trackedRuntimeFiles = @($SourceFiles) + @($BuildGroups | ForEach-Object { $_.Binary })
    $allRuntimeFilesExist = $trackedRuntimeFiles | ForEach-Object {
        Test-Path -LiteralPath (Join-Path $PluginRoot $_) -PathType Leaf
    } | Where-Object { -not $_ } | Measure-Object
    if ($allRuntimeFilesExist.Count -eq 0) {
        & git -C $PluginRoot diff --quiet HEAD -- $trackedRuntimeFiles 2>$null
        if ($LASTEXITCODE -eq 0) { return $true }
    }

    foreach ($group in $BuildGroups) {
        $binary = Join-Path $PluginRoot $group.Binary
        if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { return $false }
        $latestSource = ($group.Sources | ForEach-Object { (Get-Item -LiteralPath (Join-Path $PluginRoot $_)).LastWriteTimeUtc } | Sort-Object -Descending | Select-Object -First 1)
        if ((Get-Item -LiteralPath $binary).LastWriteTimeUtc -lt $latestSource) { return $false }
    }
    return $true
}

function Test-PatchApplicable {
    & git -C $PluginRoot apply --check --whitespace=nowarn $PatchPath 2>$null
    return $LASTEXITCODE -eq 0
}

function Get-BridgeState {
    $commit = (& git -C $PluginRoot rev-parse HEAD 2>$null)
    if (Test-SourceSupport) {
        $state = if (Test-BinariesCurrent) { 'Ready' } else { 'RebuildRequired' }
    } elseif (Test-PatchApplicable) {
        $state = 'PatchRequired'
    } else {
        $state = 'Incompatible'
    }
    [pscustomobject]@{
        state = $state
        patchVersion = $PatchVersion
        pluginCommit = [string]$commit
        pluginRoot = $PluginRoot
        sourceSupported = Test-SourceSupport
        binariesCurrent = Test-BinariesCurrent
    }
}

function Apply-BridgePatch {
    $state = Get-BridgeState
    if ($state.state -in @('Ready', 'RebuildRequired')) { return }
    if ($state.state -ne 'PatchRequired') {
        throw "BatchRender $($state.pluginCommit) is incompatible with RH camera handoff patch v$PatchVersion. No files were changed."
    }
    & git -C $PluginRoot apply --whitespace=nowarn $PatchPath
    if ($LASTEXITCODE -ne 0) { throw 'BatchRender camera handoff patch failed. No build was started.' }
}

function Build-BridgeModules {
    if (-not (Test-Path -LiteralPath $UnrealProject -PathType Leaf)) { throw "Unreal project not found: $UnrealProject" }
    $build = Join-Path $UnrealRoot 'Engine\Build\BatchFiles\Build.bat'
    if (-not (Test-Path -LiteralPath $build -PathType Leaf)) { throw "Unreal build script not found: $build" }
    if (Get-Process UnrealEditor -ErrorAction SilentlyContinue) { throw 'Close Unreal Editor before rebuilding BatchRender.' }
    & $build UnrealEditor Win64 Development "-Project=$UnrealProject" '-Module=BatchRenderEditor' '-Module=BatchRender' '-WaitMutex' '-NoHotReload'
    if ($LASTEXITCODE -ne 0) { throw "Unreal BatchRender module build failed with exit code $LASTEXITCODE" }
}

Assert-Inputs
switch ($Action) {
    'Apply' { Apply-BridgePatch }
    'Build' {
        if (-not (Test-SourceSupport)) { throw 'Camera handoff source support is missing. Run with -Action Setup or Apply first.' }
        Build-BridgeModules
    }
    'Setup' {
        Apply-BridgePatch
        if (-not (Test-BinariesCurrent)) { Build-BridgeModules }
    }
}

$result = Get-BridgeState
$result | ConvertTo-Json -Depth 4
if ($result.state -eq 'Incompatible') { exit 2 }
if ($Action -in @('Build', 'Setup') -and $result.state -ne 'Ready') { exit 3 }
