$ErrorActionPreference = 'Stop'
$backend = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Split-Path -Parent $backend
$python = Join-Path $backend '.venv\Scripts\python.exe'
$dist = Join-Path $project 'client\runner'
$temporaryRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
$work = [IO.Path]::GetFullPath((Join-Path $temporaryRoot ('soduwork-runner-build-' + [Guid]::NewGuid().ToString('N'))))
if (-not $work.StartsWith($temporaryRoot + '\soduwork-runner-build-', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Runner build directory must stay inside the system temporary directory'
}

if (-not (Test-Path -LiteralPath $python)) {
    throw 'Create hub-backend\.venv and install requirements-runner-build.txt first'
}

try {
    & $python -m PyInstaller --noconfirm --clean --distpath $dist --workpath $work (Join-Path $backend 'runner.spec')
    if ($LASTEXITCODE -ne 0) {
        throw "runner build failed with exit code $LASTEXITCODE"
    }

    $exe = Join-Path $dist 'soduwork-runner.exe'
    if (-not (Test-Path -LiteralPath $exe)) {
        throw 'runner build finished without soduwork-runner.exe'
    }
    Write-Output $exe
} finally {
    # This exact, unique directory was resolved and bounded above. Never clean
    # the shared temp root or the output directory containing the finished EXE.
    if (Test-Path -LiteralPath $work) {
        Remove-Item -LiteralPath $work -Recurse -Force
    }
}
