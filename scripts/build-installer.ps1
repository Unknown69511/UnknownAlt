<#
.SYNOPSIS
  Builds the Windows installer with its verified Microsoft WebView2 prerequisite.

.DESCRIPTION
  Release-builds the app (npm run tauri build -- --no-bundle), then compiles installer\UnknownALT.iss
  with Inno Setup 6. Prints the installer's path and SHA-256. Needs Rust (with the Build Tools'
  C++ workload), Node.js and Inno Setup 6 (https://jrsoftware.org/isdl.php).

.PARAMETER Dev
  Also keeps a copy as installers\UnknownALT-Setup-<version>-dev-<yyyyMMdd-HHmm>.exe: one installer
  per change, earlier ones never overwritten.

.PARAMETER WebView2Installer
  Optional path to a Microsoft-signed WebView2 Runtime installer. If omitted,
  downloads the official small Evergreen Bootstrapper (or x64 Standalone with
  -OfflineRuntime). The publisher signature is validated before packaging.

.PARAMETER OfflineRuntime
  Embeds the complete x64 Evergreen Standalone runtime for offline first-time
  setup. Output is UnknownALT-Setup-<version>-Windows-x64.exe. Normal builds use
  the small bootstrapper and canonical updater filename; existing runtimes are
  reused. The full offline installer is deliberately not an updater-feed asset.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1 -Dev
#>
param([switch]$Dev, [string]$InnoCompiler, [string]$PerlBin, [string]$WebView2Installer, [switch]$OfflineRuntime)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'build-paths.ps1') -SourceRoot $root

function Stop-Build([string]$What, [string]$Fix) {
    Write-Host "build-installer: $What" -ForegroundColor Red
    Write-Host "fix: $Fix"
    exit 1
}

# Runs a native command; its exit code, not its stderr, says whether it worked.
function Invoke-Native([string]$Exe, [string[]]$Arguments, [string]$Fix) {
    $ErrorActionPreference = 'Continue'
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        Stop-Build "$Exe $($Arguments -join ' ') failed (exit $LASTEXITCODE)" $Fix
    }
}

# tauri.conf.json carries the version; package.json and Cargo.toml must agree.
$version = (Get-Content -Raw "$root\src-tauri\tauri.conf.json" | ConvertFrom-Json).version
$npmVersion = (Get-Content -Raw "$root\package.json" | ConvertFrom-Json).version
$cargoVersion = [regex]::Match((Get-Content -Raw "$root\src-tauri\Cargo.toml"), '(?ms)^\[package\].*?^version\s*=\s*"([^"]+)"').Groups[1].Value
if (-not $version) { Stop-Build 'src-tauri\tauri.conf.json has no version' 'add "version": "x.y.z" to it' }
if ($npmVersion -ne $version -or $cargoVersion -ne $version) {
    Stop-Build "versions differ: src-tauri\tauri.conf.json $version, package.json $npmVersion, src-tauri\Cargo.toml $cargoVersion" 'set all three to the same version'
}

# Inno Setup first, so a missing compiler fails before the long build.
$iscc = @(
    $InnoCompiler,
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $iscc) { Stop-Build 'Inno Setup 6.6 or newer (ISCC.exe) was not found' 'install it from https://jrsoftware.org/isdl.php (or: winget install JRSoftware.InnoSetup), then run this again' }

# The runtime payload is public Microsoft software, never a WebView profile,
# user data, developer SDK, or machine-specific runtime directory. A supplied
# offline payload is useful when preparing one self-contained friend release.
$runtimeKind = if ($OfflineRuntime) { 'offline-x64' } else { 'bootstrapper' }
$runtimeUrl = if ($OfflineRuntime) { 'https://go.microsoft.com/fwlink/p/?LinkId=2124701' } else { 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' }
$runtimeDirectory = Join-Path $root 'dist-runtime'
if (-not $WebView2Installer) {
    New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
    $WebView2Installer = Join-Path $runtimeDirectory $(if ($OfflineRuntime) { 'MicrosoftEdgeWebView2RuntimeInstallerX64.exe' } else { 'MicrosoftEdgeWebview2Setup.exe' })
    Write-Host "Downloading Microsoft's WebView2 $runtimeKind prerequisite"
    $oldProgress = $ProgressPreference
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $runtimeUrl -OutFile $WebView2Installer -UseBasicParsing
    } catch {
        Stop-Build 'the Microsoft WebView2 prerequisite could not be downloaded' 'check your internet connection, or pass -WebView2Installer with an official Microsoft-signed installer'
    } finally { $ProgressPreference = $oldProgress }
}
$WebView2Installer = [IO.Path]::GetFullPath($WebView2Installer)
if (-not (Test-Path -LiteralPath $WebView2Installer -PathType Leaf)) { Stop-Build 'the WebView2 prerequisite file was not found' 'pass an existing official Microsoft WebView2 installer' }
$runtimeSignature = Get-AuthenticodeSignature -LiteralPath $WebView2Installer
if ($runtimeSignature.Status -ne 'Valid' -or $null -eq $runtimeSignature.SignerCertificate -or $runtimeSignature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
    Stop-Build 'the WebView2 prerequisite does not have a valid Microsoft Corporation publisher signature' 'download a fresh prerequisite from https://developer.microsoft.com/microsoft-edge/webview2/'
}
$runtimeHash = (Get-FileHash -LiteralPath $WebView2Installer -Algorithm SHA256).Hash.ToLowerInvariant()
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
[ordered]@{ kind=$runtimeKind; source=$runtimeUrl; sha256=$runtimeHash; bytes=(Get-Item -LiteralPath $WebView2Installer).Length; signature='Valid'; publisher=$runtimeSignature.SignerCertificate.Subject } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDirectory "WebView2-$runtimeKind-verification.json") -Encoding UTF8

# The encrypted database (SQLCipher) builds OpenSSL from source, which needs a native Perl:
# Git's MSYS Perl doesn't work for MSVC builds.
# A portable Strawberry Perl already on PATH counts too.
$pathPerl = Get-Command perl.exe -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -match 'strawberry' } | Select-Object -First 1
$perl = @($PerlBin, "C:\Strawberry\perl\bin", "$env:ProgramFiles\Strawberry\perl\bin", $(if ($pathPerl) { Split-Path $pathPerl.Source })) |
    Where-Object { $_ -and (Test-Path "$_\perl.exe") } | Select-Object -First 1
if (-not $perl) { Stop-Build 'Strawberry Perl was not found (OpenSSL, for the encrypted database, needs it to build)' 'winget install StrawberryPerl.StrawberryPerl, then run this again' }
$env:PATH = "$perl;$env:PATH"

Write-Host "Building UnknownAlt $version (release)"
Push-Location $root
try {
    if (-not (Test-Path node_modules)) {
        Invoke-Native npm.cmd @('ci') 'check your network connection; if npm says package-lock.json is out of sync, run npm install. Then run this again'
    }
    Invoke-Native npm.cmd @('run', 'tauri', '--', 'build', '--no-bundle', '--config', 'src-tauri/tauri.release.conf.json', '--', '--locked') 'fix the build error above, then run this again'
} finally {
    Pop-Location
}

# Where cargo put the build (CARGO_TARGET_DIR may move it).
$meta = & cargo metadata --no-deps --format-version 1 --manifest-path "$root\src-tauri\Cargo.toml" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { Stop-Build 'cargo metadata failed' 'run it yourself to see why' }
$exe = Join-Path $meta.target_directory 'release\unknownalt.exe'
& (Join-Path $PSScriptRoot 'assert-build-privacy.ps1') -Executable $exe -SourceRoot $root

Write-Host 'Compiling the installer'
$isccArgs = @('/Q', "/DAppVersion=$version", "/DAppNumVersion=$($version -replace '[-+].*$','')", "/DAppExe=$exe", "/DWebView2Installer=$WebView2Installer", "/DWebView2Sha256=$runtimeHash")
if ($OfflineRuntime) { $isccArgs += '/DOfflineRuntime=1' }
$isccArgs += "$root\installer\UnknownALT.iss"
# Antivirus scanning the fresh setup.exe can make ISCC's resource update fail once (error 110).
foreach ($try in 1..2) {
    $ErrorActionPreference = 'Continue'
    & $iscc @isccArgs
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 3
}
if ($LASTEXITCODE -ne 0) { Stop-Build "ISCC failed (exit $LASTEXITCODE)" 'fix the error ISCC names above, then run this again' }

$outputBase = "UnknownALT-Setup-$version" + $(if ($OfflineRuntime) { '-Windows-x64' } else { '' })
$setup = Get-Item "$root\dist-installer\$outputBase.exe"
if (-not $OfflineRuntime -and $setup.Length -gt 200000000) { Stop-Build 'the canonical update installer exceeds the supported 200 MB limit' 'keep full offline runtime payloads in the separate -OfflineRuntime build' }
if ($Dev) {
    New-Item -ItemType Directory -Force "$root\installers" | Out-Null
    $setup = Copy-Item $setup.FullName "$root\installers\$outputBase-dev-$(Get-Date -Format 'yyyyMMdd-HHmm').exe" -PassThru
}
Write-Host ''
Write-Host "Installer: $($setup.FullName)" -ForegroundColor Green
Write-Host "SHA-256:   $((Get-FileHash -Algorithm SHA256 $setup.FullName).Hash.ToLower())"
