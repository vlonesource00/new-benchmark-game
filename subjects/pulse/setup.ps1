param([switch]$SkipGpuDoctor)
$ErrorActionPreference = 'Stop'
$taskPulseRoot = $PSScriptRoot
$taskRepoRoot = Split-Path (Split-Path $taskPulseRoot -Parent) -Parent
$taskUvCommand = Get-Command uv -ErrorAction SilentlyContinue
$taskUvPath = if ($taskUvCommand) { $taskUvCommand.Source } else { Join-Path $env:LOCALAPPDATA 'hermes/bin/uv.exe' }
if (!(Test-Path -LiteralPath $taskUvPath)) { throw 'uv is missing. Install the official uv package: winget install --id astral-sh.uv' }
$taskNpmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
$taskNodePath = (Get-Command node -ErrorAction Stop).Source
if (!(Test-Path -LiteralPath (Join-Path $taskRepoRoot 'node_modules/vite'))) {
  Push-Location $taskRepoRoot
  try { & $taskNpmPath ci --no-audit --no-fund; if ($LASTEXITCODE) { throw 'Game dependency install failed' } } finally { Pop-Location }
}
& $taskUvPath sync --locked --project $taskPulseRoot --python 3.12
if ($LASTEXITCODE) { throw 'Python/CUDA dependencies failed to install' }
& $taskNpmPath ci --prefix $taskPulseRoot --no-audit --no-fund
if ($LASTEXITCODE) { throw 'PULSE Node dependencies failed to install' }
Push-Location $taskRepoRoot
try {
  & $taskNodePath --import ./scripts/json-loader.mjs subjects/pulse/tools/schema.mjs
  if ($LASTEXITCODE) { throw 'Schema export failed' }
  & $taskNodePath --import ./scripts/json-loader.mjs subjects/pulse/tools/check.mjs
  if ($LASTEXITCODE) { throw 'Simulator checks failed' }
  if (!$SkipGpuDoctor) {
    & (Join-Path $taskPulseRoot '.venv/Scripts/python.exe') subjects/pulse/training/doctor.py --schema subjects/pulse/artifacts/schema.json --out subjects/pulse/artifacts/doctor.json
    if ($LASTEXITCODE) { throw 'GPU gate failed; do not claim CUDA readiness' }
  }
} finally { Pop-Location }
Write-Host 'PULSE harness ready. Follow subjects/pulse/README.md for bounded recording/training and the replay lab.'
