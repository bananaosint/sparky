# Sparky: one line installs the Spark app, and Claude Code if it's missing. In PowerShell:
#   irm https://raw.githubusercontent.com/bananaosint/sparky/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
# The progress bar makes downloads several times slower in Windows PowerShell.
$ProgressPreference = 'SilentlyContinue'

Write-Host 'Installing Sparky...' -ForegroundColor Cyan

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host "Claude Code isn't installed yet; installing it with Anthropic's installer..." -ForegroundColor Yellow
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
}

$release = Invoke-RestMethod 'https://api.github.com/repos/bananaosint/sparky/releases/latest'
$asset = $release.assets | Where-Object { $_.name -like 'Spark-Setup-*.exe' } | Select-Object -First 1
if (-not $asset) { throw "The latest release ($($release.tag_name)) has no Spark installer." }

$setup = Join-Path $env:TEMP $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $setup -UseBasicParsing
# One-click, per-user install: no admin rights, Start Menu and desktop shortcuts.
Start-Process $setup -ArgumentList '/S' -Wait
Remove-Item $setup

# The installer names its folder after the package, so look for Spark.exe rather than guess.
$app = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Filter Spark.exe -Recurse -Depth 1 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if (-not $app) { throw 'Spark did not install under %LOCALAPPDATA%\Programs.' }
Write-Host "Sparky $($release.tag_name) is installed. Opening Spark..." -ForegroundColor Green
Write-Host 'If Claude Code is new on this machine, run claude once in a terminal to sign in.' -ForegroundColor DarkGray
Start-Process $app
