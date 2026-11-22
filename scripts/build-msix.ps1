param(
    [Parameter(Mandatory)][string]$Executable,
    [string]$OutDirectory,
    [string]$IdentityName = 'Unknown69511.UnknownAlt',
    [string]$Publisher = 'CN=UnknownAlt Local Build',
    [string]$CertificateThumbprint,
    [string]$TimestampServer
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw (Join-Path $root 'src-tauri/tauri.conf.json') | ConvertFrom-Json).version
if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)$') { throw 'MSIX requires a stable numeric version.' }
if (!$OutDirectory) { $OutDirectory = Join-Path $root 'dist-msix' }
$Binary = Get-Item -LiteralPath $Executable
if ($Binary.VersionInfo.ProductVersion -ne $version -or $Binary.VersionInfo.ProductName -notin @('UnknownALT', 'Unknown alt')) {
    throw 'The supplied EXE must be the matching clean release build of UnknownALT.'
}
& (Join-Path $PSScriptRoot 'assert-build-privacy.ps1') -Executable $Binary.FullName -SourceRoot $root
$sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$make = Get-ChildItem -LiteralPath $sdk -Filter MakeAppx.exe -Recurse -File | Where-Object { $_.Directory.Name -eq 'x64' } | Sort-Object FullName -Descending | Select-Object -First 1
if (!$make) { throw 'Install the Windows SDK with MakeAppx and SignTool.' }
if ($CertificateThumbprint) {
    if ($CertificateThumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw 'Specify a valid certificate thumbprint.' }
    $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$CertificateThumbprint"
    if (!$certificate.HasPrivateKey -or $certificate.Subject -cne $Publisher) {
        throw 'The selected signing identity must have a private key and match the exact MSIX Publisher.'
    }
}
$stage = Join-Path ([IO.Path]::GetFullPath($OutDirectory)) ('stage-' + [guid]::NewGuid().ToString('N'))
$assets = Join-Path $stage 'Assets'
New-Item -ItemType Directory -Path $assets -Force | Out-Null
[xml]$manifest = Get-Content -LiteralPath (Join-Path $root 'installer/msix/AppxManifest.xml') -Raw
$manifest.Package.Identity.SetAttribute('Name', $IdentityName)
$manifest.Package.Identity.SetAttribute('Publisher', $Publisher)
$manifest.Package.Identity.SetAttribute('Version', "$version.0")
$manifest.Save((Join-Path $stage 'AppxManifest.xml'))
Copy-Item -LiteralPath $Binary.FullName -Destination (Join-Path $stage 'UnknownALT.exe')
foreach ($icon in @('StoreLogo.png','Square150x150Logo.png','Square44x44Logo.png')) {
    Copy-Item -LiteralPath (Join-Path $root "src-tauri/icons/$icon") -Destination (Join-Path $assets $icon)
}
foreach ($notice in @('LICENSE','NOTICE.md','REBRANDING.md')) {
    Copy-Item -LiteralPath (Join-Path $root $notice) -Destination $stage
}
$package = Join-Path ([IO.Path]::GetFullPath($OutDirectory)) "UnknownALT-$version-x64.msix"
if (Test-Path -LiteralPath $package) { throw 'The package filename already exists. Pick a new output directory.' }
& $make.FullName pack /d $stage /p $package /o
if ($LASTEXITCODE -ne 0) { throw 'MakeAppx validation or packaging failed.' }
if ($CertificateThumbprint) {
    $sign = Join-Path $make.Directory.FullName 'signtool.exe'
    $signArgs = @('sign','/fd','SHA256','/sha1',$CertificateThumbprint)
    if ($TimestampServer) { $signArgs += @('/tr',$TimestampServer,'/td','SHA256') }
    & $sign @signArgs $package
    if ($LASTEXITCODE -ne 0) { throw 'SignTool could not sign the package.' }
    & $sign verify /pa $package
    if ($LASTEXITCODE -ne 0) { throw 'Signed MSIX verification failed.' }
}
Get-FileHash -LiteralPath $package -Algorithm SHA256
Get-AuthenticodeSignature -LiteralPath $package | Select-Object Status
