# Local desktop activity lease. No endpoint means an independent/headless
# Runner keeps its existing behavior. A configured bridge must acknowledge
# before input; loss of that bridge cancels instead of operating invisibly.
$script:DesktopControl = $null

function Invoke-DesktopControlRequest([string]$path, [hashtable]$body) {
  $ErrorActionPreference = 'Stop'
  $request = [System.Net.HttpWebRequest]::Create($script:DesktopControl.url + $path)
  $request.Proxy = $null
  $request.AllowAutoRedirect = $false
  $request.Method = 'POST'
  # First paint/shortcut readiness can take up to five seconds on a cold UI.
  # Heartbeat/cleanup retain a shorter bound after the operation has begun.
  $request.Timeout = if ($path -eq '/begin') { 8000 } else { 3000 }
  $request.ReadWriteTimeout = 3000
  $request.ContentType = 'application/json; charset=utf-8'
  $request.Headers['Authorization'] = 'Bearer ' + $script:DesktopControl.token
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress))
  $request.ContentLength = $bytes.Length
  $stream = $request.GetRequestStream()
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
  $response = $request.GetResponse()
  try {
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
    try {
      $text = $reader.ReadToEnd()
      if ($text.Length -gt 16384) { throw 'Invalid desktop control response' }
      $result = $text | ConvertFrom-Json
      if ($result.ok -ne $true) { throw 'Desktop operation was not acknowledged' }
      return $result
    } finally { $reader.Dispose() }
  } finally { $response.Dispose() }
}

function Start-DesktopControl([string]$action) {
  $ErrorActionPreference = 'Stop'
  $endpoint = [System.Environment]::GetEnvironmentVariable('SODUWORK_DESKTOP_CONTROL_ENDPOINT')
  if (-not $endpoint) { return }
  $info = Get-Item -LiteralPath $endpoint -ErrorAction Stop
  if (-not [System.IO.Path]::IsPathRooted($endpoint) -or $info.Length -gt 4096) {
    throw 'Invalid desktop control endpoint'
  }
  $config = [System.IO.File]::ReadAllText($endpoint, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $uri = $null
  if (-not [System.Uri]::TryCreate([string]$config.url, [System.UriKind]::Absolute, [ref]$uri) -or
      $uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or $uri.Port -lt 1 -or
      $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment -or
      [string]$config.token -notmatch '^[a-fA-F0-9]{64}$') {
    throw 'Invalid desktop control endpoint'
  }
  $scope = [System.Environment]::GetEnvironmentVariable('SODUWORK_DESKTOP_CONTROL_SCOPE')
  $script:DesktopControl = @{
    url = $uri.GetLeftPart([System.UriPartial]::Authority)
    token = [string]$config.token
    scope = [string]$scope
    leaseId = ''
  }
  $reply = Invoke-DesktopControlRequest '/begin' @{
    scope = [string]$scope
    cwd = (Get-Location).Path
    pid = $PID
    action = $action
  }
  if ($reply.cancelled -eq $true -or -not $reply.leaseId) {
    throw [System.OperationCanceledException]::new('Desktop operation cancelled')
  }
  $script:DesktopControl.leaseId = [string]$reply.leaseId
  if ($reply.scope) { $script:DesktopControl.scope = [string]$reply.scope }
}

function Assert-DesktopControl {
  if (-not $script:DesktopControl) { return }
  $reply = Invoke-DesktopControlRequest '/status' @{
    scope = $script:DesktopControl.scope
    leaseId = $script:DesktopControl.leaseId
  }
  if ($reply.cancelled -ne $false) {
    throw [System.OperationCanceledException]::new('Desktop operation cancelled')
  }
}

function Wait-DesktopControl([int]$milliseconds) {
  $remaining = [Math]::Max(0, $milliseconds)
  while ($remaining -gt 0) {
    Assert-DesktopControl
    $part = [Math]::Min(200, $remaining)
    Start-Sleep -Milliseconds $part
    $remaining -= $part
  }
}

function Stop-DesktopControl {
  if (-not $script:DesktopControl -or -not $script:DesktopControl.leaseId) { return }
  try {
    $null = Invoke-DesktopControlRequest '/end' @{
      scope = $script:DesktopControl.scope
      leaseId = $script:DesktopControl.leaseId
    }
  } catch { } # Preserve a cancelled action's original error during cleanup.
  finally { $script:DesktopControl = $null }
}

# SendKeys has no Escape method. Encode literal text without interpreting user
# prose as keyboard shortcuts; keep astral/combining text elements together.
function ConvertTo-DesktopKeys([string]$value) {
  $builder = New-Object System.Text.StringBuilder
  foreach ($character in $value.ToCharArray()) {
    $item = [string]$character
    if ($item -eq "`r") { continue }
    if ($item -eq "`n") { $null = $builder.Append('{ENTER}'); continue }
    if ($item -eq "`t") { $null = $builder.Append('{TAB}'); continue }
    if ('+^%~(){}[]'.Contains($item)) { $null = $builder.Append('{' + $item + '}') }
    else { $null = $builder.Append($item) }
  }
  return $builder.ToString()
}

function Send-DesktopText([string]$value) {
  $elements = [System.Globalization.StringInfo]::GetTextElementEnumerator($value)
  $part = New-Object System.Text.StringBuilder
  $count = 0
  while ($elements.MoveNext()) {
    $null = $part.Append($elements.GetTextElement())
    $count += 1
    if ($count -ge 16) {
      Assert-DesktopControl
      [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-DesktopKeys $part.ToString()))
      $null = $part.Clear(); $count = 0
    }
  }
  if ($part.Length) {
    Assert-DesktopControl
    [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-DesktopKeys $part.ToString()))
  }
}
