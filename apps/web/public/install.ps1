# Official Corotum installer.
# This is the only officially supported installation method.
# Manual binary download is not an officially supported installation method.
# v0.1 binaries are unsigned.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-InstallerError {
  param([string]$Message)
  [Console]::Error.WriteLine($Message)
}

function Get-ReleaseTarget {
  if ($env:TOOLMIRROR_OS -and $env:TOOLMIRROR_OS -ne "windows") {
    throw "Use the official Unix installer: curl -fsSL https://corotum.com/install.sh | sh"
  }
  $arch = $env:TOOLMIRROR_ARCH
  if (-not $arch) {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") {
      throw "Windows arm64 is not supported in Corotum v0.1."
    }
    $arch = "x64"
  }
  if ($arch -ne "x64") {
    throw "Unsupported Windows architecture: $arch"
  }
  return "windows-x64"
}

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Add-UserPath {
  param([string]$Directory)
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  if ([string]::IsNullOrEmpty($current)) {
    [Environment]::SetEnvironmentVariable("Path", $Directory, "User")
    return
  }
  $normalized = $Directory.TrimEnd("\")
  foreach ($part in $current.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries)) {
    if ([string]::Equals($part.TrimEnd("\"), $normalized, [StringComparison]::OrdinalIgnoreCase)) {
      return
    }
  }
  $updated = $current.TrimEnd(";") + ";" + $Directory
  [Environment]::SetEnvironmentVariable("Path", $updated, "User")
}

Write-Output "Official Corotum installer"
Write-Output "This is the only officially supported installation method."
Write-Output "Manual binary download is not an officially supported installation method."
Write-Output "v0.1 binaries are unsigned."

$target = Get-ReleaseTarget
$releaseBase = $env:TOOLMIRROR_RELEASE_BASE
if ([string]::IsNullOrEmpty($releaseBase)) {
  $releaseBase = "https://releases.corotum.com"
}
$releaseBase = $releaseBase.TrimEnd("/")

$binDir = $env:TOOLMIRROR_BIN_DIR
if ([string]::IsNullOrEmpty($binDir)) {
  $binDir = Join-Path $env:LOCALAPPDATA "ToolMirror\bin"
}
$dest = Join-Path $binDir "corotum.exe"
$filename = "corotum-$target.tar.gz"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("corotum-install-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  Write-Output "Fetching official release metadata for $target"
  $latestPath = Join-Path $tmp "latest.json"
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/releases/latest.json" -OutFile $latestPath
  $latest = Get-Content -Raw $latestPath | ConvertFrom-Json
  if (-not $latest.version) {
    throw "latest.json is missing version."
  }
  if ($latest.version -notmatch '^\d+\.\d+\.\d+$') {
    throw "latest.json version is invalid."
  }
  $artifact = $latest.artifacts.$target
  if (-not $artifact) {
    throw "latest.json is missing $target."
  }

  $checksumsPath = Join-Path $tmp "checksums.txt"
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/releases/v$($latest.version)/checksums.txt" -OutFile $checksumsPath
  $expected = $null
  $checksumPattern = '^([a-fA-F0-9]{64})  binaries/' + [regex]::Escape($filename) + '$'
  foreach ($line in Get-Content $checksumsPath) {
    if ($line -match $checksumPattern) {
      $expected = $Matches[1].ToLowerInvariant()
      break
    }
  }
  if (-not $expected) {
    throw "checksums.txt is missing binaries/$filename."
  }

  Write-Output "Downloading Corotum $($latest.version) ($target)"
  $archivePath = Join-Path $tmp $filename
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/releases/v$($latest.version)/binaries/$filename" -OutFile $archivePath
  $actual = Get-Sha256 $archivePath
  if ($actual -ne $expected) {
    throw "SHA-256 mismatch for $filename. Existing install was not replaced."
  }
  if ($artifact.sha256 -and $artifact.sha256.ToLowerInvariant() -ne $actual) {
    throw "SHA-256 mismatch for $filename. Existing install was not replaced."
  }

  $extractDir = Join-Path $tmp "extract"
  New-Item -ItemType Directory -Path $extractDir | Out-Null
  tar -xzf $archivePath -C $extractDir
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to unpack the official Corotum archive."
  }
  $staged = Join-Path $extractDir "corotum.exe"
  if (-not (Test-Path $staged)) {
    throw "Official archive did not contain corotum.exe."
  }

  & $staged --version
  if ($LASTEXITCODE -ne 0) {
    throw "Official binary failed --version. Existing install was not replaced."
  }

  New-Item -ItemType Directory -Path $binDir -Force | Out-Null
  Move-Item -Force $staged $dest
  Add-UserPath $binDir
  Write-Output "Installed $dest"
  Write-Output "Corotum was installed with the official installer."
}
catch {
  Write-InstallerError $_.Exception.Message
  exit 1
}
finally {
  if (Test-Path $tmp) {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}
