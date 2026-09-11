# Run as your normal signed-in Windows desktop user. Installer UAC prompts are separate.
[CmdletBinding()]
param([switch]$SkipFunnel, [switch]$Computer, [switch]$NoStart)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location (Join-Path $PSScriptRoot '..')
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Close this elevated window. Run setup as your normal desktop user; individual installers can request UAC.'
}
if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw 'Install or update Microsoft App Installer (https://aka.ms/getwinget), then rerun this script.'
}
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Install-Package([string]$Id) {
    Write-Host "Installing $Id using Windows Package Manager..."
    & winget.exe install --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { throw "winget failed for $Id (exit $LASTEXITCODE). Resolve the displayed installer error and rerun." }
    Refresh-Path
}
Refresh-Path
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Install-Package 'OpenJS.NodeJS.LTS' }
else {
    $major = [int]((& node.exe -p 'process.versions.node.split(".")[0]') | Select-Object -Last 1)
    if ($major -lt 22) { Install-Package 'OpenJS.NodeJS.LTS' }
}
if (-not (Get-Command rg.exe -ErrorAction SilentlyContinue)) { Install-Package 'BurntSushi.ripgrep.MSVC' }
$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (-not (Test-Path $tailscale)) { Install-Package 'Tailscale.Tailscale' }
$pythonPath = $null
if ($Computer) {
    $candidates = @((Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'), (Join-Path $env:ProgramFiles 'Python312\python.exe'))
    $pythonPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $pythonPath) { Install-Package 'Python.Python.3.12'; $pythonPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1 }
    if (-not $pythonPath) { throw 'Python 3.12 was not found at the standard install locations. Run node scripts/setup.mjs --computer --python C:\full\path\python.exe.' }
}
$state = if ($env:CODEX_LINK_HOME) { $env:CODEX_LINK_HOME } else { Join-Path $env:LOCALAPPDATA 'CodexLink' }
New-Item -ItemType Directory -Path $state -Force | Out-Null
# Fresh state directory: grant only this user and SYSTEM; never change the project/workspace ACLs.
& icacls.exe $state /inheritance:r /grant:r "*$($identity.User.Value):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Cannot protect the state directory ACL. Resolve this before exposing the MCP endpoint.' }
$arguments = @('scripts/setup.mjs', '--skip-funnel')
if ($Computer) { $arguments += @('--computer', '--python', $pythonPath) }
if ($SkipFunnel) { $arguments += '--skip-funnel' }
& node.exe @arguments
if ($LASTEXITCODE -ne 0) { throw 'Codex Link dependency setup failed. Review the output above.' }
if (-not $NoStart) {
    $env:CODEX_LINK_OPEN_BROWSER = '1'
    & node.exe src/main.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Codex Link exited with an error.' }
}
