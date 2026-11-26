# Only the installer's freshly allocated stage can be retired. Keep the cleanup
# independent of Electron: the failed payload may be missing that executable.
$ErrorActionPreference = 'Stop'
function Remove-FailedStage {
    $stage = $env:SODUWORK_ROLLBACK_STAGE
    $token = ([Guid]$env:SODUWORK_ROLLBACK_TOKEN).ToString('D')
    $name = [IO.Path]::GetFileName($stage)
    $versions = [IO.Directory]::GetParent($stage)
    if ($name -notmatch '^ns[a-z0-9]+\.tmp$' -or $versions.Name -ne '.soduwork-versions') { throw 'Invalid rollback stage' }
    $root = $versions.Parent
    $retired = Join-Path $root.FullName '.soduwork-retired'
    $target = Join-Path $retired "$name-$token"
    $receipt = "$target.json"
    foreach ($path in @($stage, $retired, $target)) {
        for ($dir = [IO.DirectoryInfo]$path; $dir; $dir = $dir.Parent) {
            if ($dir.Exists -and ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'Rollback directory is a reparse point'
            }
        }
    }
    if (-not [IO.Directory]::Exists($stage)) { return }
    $marker = Join-Path $stage '.soduwork-stage'
    if ([IO.File]::ReadAllText($marker) -ne $env:SODUWORK_ROLLBACK_TOKEN) { return }
    foreach ($pointer in '.soduwork-active', '.soduwork-previous') {
        $file = Join-Path $root.FullName $pointer
        if ([IO.File]::Exists($file) -and [IO.File]::ReadAllText($file) -eq $name) { return }
    }
    [void][IO.Directory]::CreateDirectory($retired)
    $record = @{schema=1; kind='soduwork-retired-version'; name="$name-$token"; source=$name} | ConvertTo-Json -Compress
    $stream = [IO.File]::Open($receipt, 'CreateNew', 'Write', 'None')
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($record)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
    try { [IO.Directory]::Move($stage, $target) }
    catch { [IO.File]::Delete($receipt); throw }

    # This invocation made the receipt and moved this stage. A later pruner
    # can finish deleting it if another handle opens during removal.
    if ([IO.File]::ReadAllText((Join-Path $target '.soduwork-stage')) -ne $env:SODUWORK_ROLLBACK_TOKEN) { throw 'Stage changed during rollback' }
    # Directory.Delete removes directory links themselves. Extended paths
    # cover bundled runtime files longer than MAX_PATH on Windows 10.
    $extended = if ($target.StartsWith('\\')) { '\\?\UNC\' + $target.Substring(2) } else { '\\?\' + $target }
    [IO.Directory]::Delete($extended, $true)
    [IO.File]::Delete($receipt)
}
try {
    Remove-FailedStage
    exit 0
} catch [IO.IOException], [UnauthorizedAccessException] {
    # A scanner or another process can hold the DLL until Setup exits. The
    # child inherits the transaction token and the function itself, so Setup
    # can close and discard its plugin directory before the retry runs.
    $retry = @'
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    $lock = $null
    try {
        $root = [IO.Directory]::GetParent($env:SODUWORK_ROLLBACK_STAGE).Parent.FullName
        $lock = [IO.File]::Open((Join-Path $root '.soduwork-update.lock'), 'Open', 'ReadWrite', 'None')
        Remove-FailedStage
        exit 0
    } catch [IO.IOException], [UnauthorizedAccessException] {
        continue
    } finally { if ($lock) { $lock.Dispose() } }
}
exit 2
'@
    $command = '$ErrorActionPreference = "Stop"' + [Environment]::NewLine +
        'function Remove-FailedStage {' + ${function:Remove-FailedStage}.ToString() + '}' + [Environment]::NewLine + $retry
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand',$encoded -WindowStyle Hidden
    exit 3
}
