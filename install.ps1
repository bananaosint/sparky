# Spark installer for Windows. Run in PowerShell:
#   irm https://raw.githubusercontent.com/bananaosint/sparky/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

function Require($command, $hint) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    Write-Host "Spark needs $command. $hint" -ForegroundColor Red
    throw "missing $command"
  }
}

Write-Host 'Installing Spark...' -ForegroundColor Cyan
Require node 'Install Node.js 24 or newer from https://nodejs.org, then run this again.'
$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 24) {
  Write-Host "Spark needs Node.js 24 or newer; this machine has $(node --version)." -ForegroundColor Red
  throw 'node too old'
}
Require git 'Install Git for Windows from https://git-scm.com/download/win, then run this again.'
Require claude 'Install Claude Code from https://claude.com/claude-code, then run this again.'

npm install -g github:bananaosint/sparky
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

# Windows Terminal profile with Sparky's icon and background, plus Start Menu and desktop shortcuts.
spark install

if ((spark doctor | Out-String) -match 'no Gemini key') {
  if ([Console]::IsInputRedirected) {
    Write-Host 'Add your Gemini API key with: spark key set' -ForegroundColor Yellow
  } else {
    Write-Host 'Paste a Gemini API key (free from https://aistudio.google.com/apikey) to turn on prompt cooking.' -ForegroundColor Cyan
    spark key set
  }
}

Write-Host 'Spark is ready. Open "Spark" from the Start Menu, or run spark in any project folder.' -ForegroundColor Green
