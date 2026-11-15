# UnknownAlt's embedded update transaction helper. Windows PowerShell 5.1; no network access.
# Rust substitutes the embedded release trust below before staging this file in a private folder.
[CmdletBinding()]
param([string]$RequestFile, [switch]$Recover, [switch]$ValidateOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:UnknownAltChannel = [pscustomobject]@{
    schemaVersion = 1; owner = '__UNKNOWNALT_OWNER__'; repository = '__UNKNOWNALT_REPOSITORY__'
    channel = '__UNKNOWNALT_CHANNEL__'; publicKeyP256 = '__UNKNOWNALT_PUBLIC_KEY__'
}
$script:UnknownAltUninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{25C70510-83BD-4A26-B6AA-7D831FC934F3}_is1'
$script:UnknownAltRunOnceKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$script:UnknownAltRunOnceName = 'UnknownAltUpdateRecovery'
$script:Utf8 = New-Object System.Text.UTF8Encoding($false, $true)

function Get-UpdatePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Substring(2).Contains(':')) { throw 'An update path is not an ordinary absolute local path.' }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full.Length -lt 4) { throw 'An update path cannot be a drive root.' }
    $cursor = $full
    while ($cursor.Length -gt 3) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Update paths cannot contain links or junctions.' }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
        if ([string]::IsNullOrEmpty($cursor)) { break }
    }
    return $full
}

function Test-UpdatePathEqual([string]$Left, [string]$Right) {
    return [string]::Equals((Get-UpdatePath $Left), (Get-UpdatePath $Right), [StringComparison]::OrdinalIgnoreCase)
}

function Assert-UpdateChild([string]$Path, [string]$Root, [switch]$AllowRoot) {
    $full = Get-UpdatePath $Path; $base = Get-UpdatePath $Root
    if (($AllowRoot -and [string]::Equals($full, $base, [StringComparison]::OrdinalIgnoreCase)) -or $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { return $full }
    throw 'An update operation escaped its intended folder.'
}

function Assert-UpdateSeparate([string]$Left, [string]$Right) {
    $a = Get-UpdatePath $Left; $b = Get-UpdatePath $Right
    if ([string]::Equals($a, $b, [StringComparison]::OrdinalIgnoreCase) -or $a.StartsWith($b + '\', [StringComparison]::OrdinalIgnoreCase) -or $b.StartsWith($a + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Installation, staging and data folders must be separate.' }
}

function Read-UpdateJson([string]$Path, [int]$Limit = 131072) {
    $full = Get-UpdatePath $Path
    $info = Get-Item -LiteralPath $full -Force
    if ($info.PSIsContainer -or $info.Length -gt $Limit) { throw 'An update metadata file has an invalid size.' }
    return ($script:Utf8.GetString([IO.File]::ReadAllBytes($full)) | ConvertFrom-Json)
}

function Write-UpdateJson([string]$Path, $Value, [string]$Root, [int]$Limit = 16000000) {
    $full = Assert-UpdateChild $Path $Root
    $parent = [IO.Path]::GetDirectoryName($full)
    [void][IO.Directory]::CreateDirectory($parent)
    $temp = Assert-UpdateChild ($full + '.' + [guid]::NewGuid().ToString('N') + '.tmp') $Root
    $bytes = $script:Utf8.GetBytes(($Value | ConvertTo-Json -Depth 20 -Compress) + "`n")
    if ($bytes.Length -gt $Limit) { throw 'The update recovery metadata exceeded its safe size limit. Nothing further was installed.' }
    $stream = New-Object IO.FileStream($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if (Test-Path -LiteralPath $full) { [IO.File]::Replace($temp, $full, [System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temp, $full) }
}

function Assert-UpdateFields($Value, [string[]]$Names) {
    $actual = @($Value.PSObject.Properties.Name)
    if ($actual.Count -ne $Names.Count) { throw 'Update metadata contains unexpected or missing fields.' }
    foreach ($name in $Names) { if ($actual -cnotcontains $name) { throw 'Update metadata contains unexpected or missing fields.' } }
}

function Get-UpdateVersion([string]$Value) {
    if ($Value -cnotmatch '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$') { throw 'The update version is not a stable three-part version.' }
    return [version]$Value
}

function Test-UpdateSignature([byte[]]$ManifestBytes, [string]$SignatureText, [string]$PublicKeyHex) {
    if ($ManifestBytes.Length -eq 0 -or $ManifestBytes.Length -gt 128000 -or $PublicKeyHex -cnotmatch '^[0-9a-f]{128}$') { throw 'The update signature inputs are invalid.' }
    $text = $SignatureText.Trim()
    if ($text -cnotmatch '^[A-Za-z0-9+/]{86}==$') { throw 'The update signature encoding is invalid.' }
    $signatureBytes = [Convert]::FromBase64String($text)
    $coordinates = New-Object byte[] 64
    for ($n = 0; $n -lt 64; $n++) { $coordinates[$n] = [Convert]::ToByte($PublicKeyHex.Substring($n * 2, 2), 16) }
    $blob = New-Object byte[] 72
    [Array]::Copy([BitConverter]::GetBytes([uint32]0x31534345), 0, $blob, 0, 4)
    [Array]::Copy([BitConverter]::GetBytes([uint32]32), 0, $blob, 4, 4)
    [Array]::Copy($coordinates, 0, $blob, 8, 64)
    $prefix = $script:Utf8.GetBytes("UnknownAlt update manifest v1`n")
    $signed = New-Object byte[] ($prefix.Length + $ManifestBytes.Length)
    [Array]::Copy($prefix, 0, $signed, 0, $prefix.Length)
    [Array]::Copy($ManifestBytes, 0, $signed, $prefix.Length, $ManifestBytes.Length)
    $key = [Security.Cryptography.CngKey]::Import($blob, [Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
    $ecdsa = New-Object Security.Cryptography.ECDsaCng($key)
    try { return $ecdsa.VerifyData($signed, $signatureBytes, [Security.Cryptography.HashAlgorithmName]::SHA256) } finally { $ecdsa.Dispose(); $key.Dispose() }
}

function Assert-UpdateManifest([byte[]]$ManifestBytes, [string]$SignatureText, $Channel, [string]$ExpectedVersion, [string]$CurrentVersion) {
    if ($Channel.schemaVersion -ne 1 -or $Channel.channel -cne 'stable' -or $Channel.owner -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$' -or $Channel.repository -notmatch '^[A-Za-z0-9_.-]{1,100}$' -or $Channel.repository -in @('.', '..') -or $Channel.owner -ieq 'inspectsoftware' -or $Channel.repository -ieq 'roalt') { throw 'UnknownAlt must use its own configured release channel.' }
    if (-not (Test-UpdateSignature $ManifestBytes $SignatureText $Channel.publicKeyP256)) { throw 'The update signature did not verify.' }
    $manifest = $script:Utf8.GetString($ManifestBytes) | ConvertFrom-Json
    Assert-UpdateFields $manifest @('schemaVersion','appId','channel','version','platform','installer')
    Assert-UpdateFields $manifest.installer @('fileName','url','sha256','size')
    $version = Get-UpdateVersion $manifest.version
    if ($version -le (Get-UpdateVersion $CurrentVersion) -or $manifest.version -cne $ExpectedVersion -or $manifest.schemaVersion -ne 1 -or $manifest.appId -cne 'com.unknownalt.desktop' -or $manifest.channel -cne $Channel.channel -or $manifest.platform -cne 'windows-x86_64') { throw 'The signed release does not match this UnknownAlt update.' }
    $name = 'UnknownAlt-Setup-' + $manifest.version + '.exe'
    $url = 'https://github.com/' + $Channel.owner + '/' + $Channel.repository + '/releases/download/v' + $manifest.version + '/' + $name
    if ($manifest.installer.fileName -cne $name -or $manifest.installer.url -cne $url -or $manifest.installer.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $manifest.installer.size -isnot [ValueType] -or $manifest.installer.size -le 0 -or $manifest.installer.size -gt 200000000 -or [decimal]$manifest.installer.size -ne [decimal][long]$manifest.installer.size) { throw 'The signed installer location, hash or size is invalid.' }
    return $manifest
}

function Assert-UpdateInstaller([string]$Path, $Manifest) {
    $full = Get-UpdatePath $Path; $info = Get-Item -LiteralPath $full -Force
    if ($info.PSIsContainer -or $info.Length -ne $Manifest.installer.size -or $info.Name -cne $Manifest.installer.fileName) { throw 'The installer filename or size did not match its signed manifest.' }
    if ((Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Manifest.installer.sha256) { throw 'The installer hash did not match its signed manifest.' }
}

function Get-UpdateContext {
    $registration = Get-ItemProperty -LiteralPath $script:UnknownAltUninstallKey -Name InstallLocation -ErrorAction SilentlyContinue
    $location = ''; if ($null -ne $registration) { $location = $registration.InstallLocation }
    return [pscustomobject]@{ localAppData = $env:LOCALAPPDATA; appData = $env:APPDATA; installLocation = $location }
}

function Assert-UpdateRequest($Request, $Context, [switch]$Recovery) {
    Assert-UpdateFields $Request @('schema','parentPid','parentStartFileTime','currentVersion','currentExe','installDir','dataDir','defaultDataDir','stageDir','expectedVersion','installerFile','manifestFile','signatureFile','readyFile','outcomeFile','healthFile','healthNonce')
    if ($Request.schema -ne 1 -or $Request.parentPid -le 0 -or [decimal]$Request.parentStartFileTime -le 0 -or $Request.healthNonce -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'The update request identity is invalid.' }
    [void](Get-UpdateVersion $Request.currentVersion); [void](Get-UpdateVersion $Request.expectedVersion)
    $stage = Get-UpdatePath $Request.stageDir
    $stageRoot = Join-Path $Context.localAppData 'UnknownAlt-update-staging'
    if (-not (Test-UpdatePathEqual ([IO.Path]::GetDirectoryName($stage)) $stageRoot) -or [IO.Path]::GetFileName($stage) -cnotmatch '^unknownalt-update-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'The update stage is outside UnknownAlt private staging.' }
    if (-not (Test-UpdatePathEqual $Request.defaultDataDir (Join-Path $Context.localAppData 'UnknownAlt')) -or -not (Test-UpdatePathEqual $Request.outcomeFile (Join-Path $Request.defaultDataDir 'update-result.json'))) { throw 'The update data location is invalid.' }
    if (-not (Test-UpdatePathEqual $Request.installDir $Context.installLocation) -or -not (Test-UpdatePathEqual $Request.currentExe (Join-Path $Request.installDir 'UnknownAlt.exe'))) { throw 'Only the registered UnknownAlt installation can update itself.' }
    foreach ($name in @('manifestFile','signatureFile','readyFile','healthFile','installerFile')) { [void](Assert-UpdateChild $Request.$name $stage); if (-not (Test-UpdatePathEqual ([IO.Path]::GetDirectoryName($Request.$name)) $stage)) { throw 'Update payload files must be directly inside their stage.' } }
    $fixed = @{ manifestFile='UnknownAlt-update.json'; signatureFile='UnknownAlt-update.json.sig'; readyFile='ready.json'; healthFile='health.json'; installerFile=('UnknownAlt-Setup-' + $Request.expectedVersion + '.exe') }
    foreach ($name in $fixed.Keys) { if ([IO.Path]::GetFileName($Request.$name) -cne $fixed[$name]) { throw 'An update file has an unexpected filename.' } }
    foreach ($data in @($Request.dataDir, $Request.defaultDataDir, (Join-Path $Context.appData 'com.unknownalt.desktop'))) { Assert-UpdateSeparate $Request.installDir $data; Assert-UpdateSeparate $stage $data }
    Assert-UpdateSeparate $stage $Request.installDir
    foreach ($root in @($env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $Context.localAppData, $Context.appData, $env:USERPROFILE)) {
        if (-not [string]::IsNullOrEmpty($root) -and ((Test-UpdatePathEqual $Request.installDir $root) -or (Test-UpdatePathEqual $Request.dataDir $root))) { throw 'An update target is a Windows or profile root.' }
    }
    if (-not (Test-UpdatePathEqual $Request.dataDir $Request.defaultDataDir)) {
        Assert-UpdateSeparate $Request.dataDir $Request.defaultDataDir
        if (-not $Recovery) {
            $location = Read-UpdateJson (Join-Path $Request.defaultDataDir 'location.json')
            if (-not (Test-UpdatePathEqual $location.dataDir $Request.dataDir)) { throw 'The active data-folder pointer changed before updating.' }
        }
    }
    return $Request
}

function Get-UpdateProcessIdentity([int]$ProcessId) {
    $targetProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $targetProcess) { return $null }
    try { return [pscustomobject]@{ processId = $targetProcess.Id; start = $targetProcess.StartTime.ToFileTimeUtc().ToString(); path = (Get-UpdatePath $targetProcess.Path) } } catch { throw 'An update process identity could not be verified.' }
}

function Test-UpdateProcessAlive($Identity) {
    $current = Get-UpdateProcessIdentity ([int]$Identity.processId)
    return ($null -ne $current -and $current.start -ceq [string]$Identity.start -and (Test-UpdatePathEqual $current.path $Identity.path))
}

function Assert-UpdateParent($Request) {
    $identity = Get-UpdateProcessIdentity ([int]$Request.parentPid)
    if ($null -eq $identity -or $identity.start -cne [string]$Request.parentStartFileTime -or -not (Test-UpdatePathEqual $identity.path $Request.currentExe)) { throw 'The UnknownAlt process requesting this update no longer matches.' }
    return $identity
}

function Get-UpdateWebViews([int]$ParentProcessId) {
    $processes = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name)
    $tree = New-Object 'System.Collections.Generic.HashSet[int]'; [void]$tree.Add($ParentProcessId)
    do { $added = $false; foreach ($entry in $processes) { if ($tree.Contains([int]$entry.ParentProcessId) -and $tree.Add([int]$entry.ProcessId)) { $added = $true } } } while ($added)
    $result = @()
    foreach ($entry in $processes) { if ($tree.Contains([int]$entry.ProcessId) -and $entry.Name -ieq 'msedgewebview2.exe') { $identity = Get-UpdateProcessIdentity ([int]$entry.ProcessId); if ($null -ne $identity) { $result += $identity } } }
    return $result
}

function Wait-UpdateProcesses([object[]]$Identities, [int]$Seconds = 120) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $alive = @($Identities | Where-Object { Test-UpdateProcessAlive $_ })
        if ($alive.Count -eq 0) { return }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'UnknownAlt did not finish closing in time. Nothing was installed.' }
        Start-Sleep -Milliseconds 200
    } while ($true)
}

function Assert-UpdateNoApp([string]$Executable) {
    foreach ($targetProcess in @(Get-Process -Name UnknownAlt -ErrorAction SilentlyContinue)) {
        $identity = Get-UpdateProcessIdentity $targetProcess.Id
        if ($null -ne $identity -and (Test-UpdatePathEqual $identity.path $Executable)) { throw 'Another UnknownAlt window is still using this installation.' }
    }
}

function Wait-UpdateInstaller($Request) {
    # Also covers power loss immediately between process creation and saving its PID in the journal.
    $identities = @()
    foreach ($targetProcess in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($Request.installerFile)) -ErrorAction SilentlyContinue)) {
        $identity = Get-UpdateProcessIdentity $targetProcess.Id
        if ($null -ne $identity -and (Test-UpdatePathEqual $identity.path $Request.installerFile)) { $identities += $identity }
    }
    Wait-UpdateProcesses $identities 120
}

function Assert-UpdateBinary([string]$Executable, [string]$ExpectedVersion) {
    $info = [Diagnostics.FileVersionInfo]::GetVersionInfo((Get-UpdatePath $Executable))
    $numeric = '{0}.{1}.{2}' -f $info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart
    # Tauri's PE resources do not populate OriginalFilename; the request pins the actual basename.
    $expectedName = if ((Get-UpdateVersion $ExpectedVersion) -ge [version]'1.1.3') { 'Unknown alt' } else { 'UnknownAlt' }
    if ($info.ProductName -cne $expectedName -or $numeric -cne $ExpectedVersion) { throw 'The installed executable is not the expected Unknown alt version.' }
}

function Open-UpdateLock([string]$Path, [string]$Root, $Metadata) {
    $full = Assert-UpdateChild $Path $Root
    $stream = New-Object IO.FileStream($full, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    if ($null -ne $Metadata) {
        $bytes = $script:Utf8.GetBytes(($Metadata | ConvertTo-Json -Compress))
        $stream.SetLength(0); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
    }
    return $stream
}

function Copy-UpdateFile([string]$Source, [string]$Destination, [string]$SourceRoot, [string]$DestinationRoot) {
    $src = Assert-UpdateChild $Source $SourceRoot; $dst = Assert-UpdateChild $Destination $DestinationRoot
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dst))
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        try {
            [IO.File]::Copy($src, $dst, $true)
            if ((Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash -or (Get-Item -LiteralPath $src).Length -ne (Get-Item -LiteralPath $dst).Length) { throw 'A backup copy did not verify.' }
            return
        } catch { if ($attempt -eq 3) { throw }; Start-Sleep -Milliseconds 500 }
    }
}

function Copy-UpdateTree([string]$Source, [string]$Destination, [string]$DestinationRoot) {
    $src = Get-UpdatePath $Source; $dst = Assert-UpdateChild $Destination $DestinationRoot
    $record = [ordered]@{ existed = (Test-Path -LiteralPath $src); files = @(); directories = @() }
    if (-not $record.existed) { return [pscustomobject]$record }
    if (-not (Get-Item -LiteralPath $src -Force).PSIsContainer) { throw 'A backup source is not a folder.' }
    [void][IO.Directory]::CreateDirectory($dst)
    $pending = New-Object 'System.Collections.Generic.Queue[string]'; $pending.Enqueue($src)
    while ($pending.Count -gt 0) {
        $directory = $pending.Dequeue(); [void](Assert-UpdateChild $directory $src -AllowRoot)
        foreach ($entry in @(Get-ChildItem -LiteralPath $directory -Force)) {
            $path = Assert-UpdateChild $entry.FullName $src
            $relative = $path.Substring($src.Length + 1)
            $target = Assert-UpdateChild (Join-Path $dst $relative) $dst
            if ($entry.PSIsContainer) { [void][IO.Directory]::CreateDirectory($target); $record.directories += $relative; $pending.Enqueue($path) }
            else {
                # Even caches are copied and verified; inability to preserve any data aborts safely.
                Copy-UpdateFile $path $target $src $dst
                $record.files += [pscustomobject]@{ path = $relative; size = (Get-Item -LiteralPath $target).Length; sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() }
            }
        }
    }
    return [pscustomobject]$record
}

function Assert-UpdateTree([string]$Snapshot, $Record, [string]$Stage) {
    $base = Assert-UpdateChild $Snapshot $Stage
    if (-not $Record.existed) { return }
    foreach ($entry in @($Record.files)) {
        $file = Assert-UpdateChild (Join-Path $base $entry.path) $base
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -ne $entry.size -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) { throw 'A recovery snapshot failed verification. It has been retained.' }
    }
}

function Remove-UpdateTree([string]$Path, [string]$Root) {
    $full = Assert-UpdateChild $Path $Root
    if (Test-Path -LiteralPath $full) {
        # Recheck every descendant before recursive deletion. A junction must never expand scope.
        foreach ($entry in @(Get-ChildItem -LiteralPath $full -Force -Recurse)) { [void](Assert-UpdateChild $entry.FullName $full) }
        Remove-Item -LiteralPath $full -Force -Recurse
    }
}

function Clear-UpdateDataFolder([string]$Path) {
    $full = Get-UpdatePath $Path
    if (-not (Test-Path -LiteralPath $full)) { return }
    foreach ($entry in @(Get-ChildItem -LiteralPath $full -Force)) {
        $child = Assert-UpdateChild $entry.FullName $full
        if ($entry.PSIsContainer) { Remove-UpdateTree $child $full } else { Remove-Item -LiteralPath $child -Force }
    }
}

function Restore-UpdateTree([string]$Snapshot, $Record, [string]$Destination, [string]$Stage) {
    Assert-UpdateTree $Snapshot $Record $Stage
    $dst = Get-UpdatePath $Destination
    Clear-UpdateDataFolder $dst
    if (-not $Record.existed) { return }
    [void][IO.Directory]::CreateDirectory($dst)
    foreach ($relative in @($Record.directories)) { [void][IO.Directory]::CreateDirectory((Assert-UpdateChild (Join-Path $dst $relative) $dst)) }
    foreach ($entry in @($Record.files)) { Copy-UpdateFile (Join-Path $Snapshot $entry.path) (Join-Path $dst $entry.path) $Snapshot $dst }
}

function Get-UpdateManagedNames([string]$InstallDir) {
    $names = @('UnknownAlt.exe','UnknownAlt.ico','LICENSE.txt','REBRANDING.md')
    foreach ($item in @(Get-ChildItem -LiteralPath $InstallDir -Force -File)) { if ($item.Name -cmatch '^unins[0-9]{3}\.(exe|dat)$') { $names += $item.Name } }
    return @($names | Select-Object -Unique)
}

function Backup-UpdateManaged([string]$InstallDir, [string]$BackupDir, [string]$Stage) {
    $backup = Assert-UpdateChild $BackupDir $Stage; [void][IO.Directory]::CreateDirectory($backup)
    $record = @()
    foreach ($name in @(Get-UpdateManagedNames $InstallDir)) {
        $source = Assert-UpdateChild (Join-Path $InstallDir $name) $InstallDir
        $exists = Test-Path -LiteralPath $source -PathType Leaf
        $item = [ordered]@{ name = $name; existed = $exists; size = 0; sha256 = '' }
        if ($exists) { $target = Join-Path $backup $name; Copy-UpdateFile $source $target $InstallDir $backup; $item.size = (Get-Item -LiteralPath $target).Length; $item.sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() }
        $record += [pscustomobject]$item
    }
    return $record
}

function Restore-UpdateManaged([string]$InstallDir, [string]$BackupDir, $Record, [string]$Stage) {
    $backup = Assert-UpdateChild $BackupDir $Stage
    foreach ($item in @($Record)) {
        if ($item.name -cnotmatch '^(UnknownAlt\.exe|UnknownAlt\.ico|LICENSE\.txt|REBRANDING\.md|unins[0-9]{3}\.(exe|dat))$') { throw 'An unowned file appeared in the recovery record.' }
        if ($item.existed) {
            $source = Assert-UpdateChild (Join-Path $backup $item.name) $backup
            if ((Get-Item -LiteralPath $source).Length -ne $item.size -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item.sha256) { throw 'The old application backup failed verification.' }
        }
    }
    foreach ($name in @(Get-UpdateManagedNames $InstallDir)) {
        $old = @($Record | Where-Object { $_.name -ceq $name })
        if ($old.Count -eq 0 -or -not $old[0].existed) { $target = Assert-UpdateChild (Join-Path $InstallDir $name) $InstallDir; if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force } }
    }
    foreach ($item in @($Record)) { if ($item.existed) { Copy-UpdateFile (Join-Path $backup $item.name) (Join-Path $InstallDir $item.name) $backup $InstallDir } }
}

function Backup-UpdateRegistry {
    $key = Get-Item -LiteralPath $script:UnknownAltUninstallKey
    $record = @()
    foreach ($name in $key.GetValueNames()) { $record += [pscustomobject]@{ name = $name; kind = $key.GetValueKind($name).ToString(); value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } }
    return $record
}

function Restore-UpdateRegistry($Record) {
    if (-not (Test-Path -LiteralPath $script:UnknownAltUninstallKey)) { [void](New-Item -Path $script:UnknownAltUninstallKey -Force) }
    $key = Get-Item -LiteralPath $script:UnknownAltUninstallKey
    foreach ($name in @($key.GetValueNames())) { $key.DeleteValue($name, $false) }
    foreach ($entry in @($Record)) {
        $kind = [Microsoft.Win32.RegistryValueKind][Enum]::Parse([Microsoft.Win32.RegistryValueKind], $entry.kind)
        $value = $entry.value
        if ($kind -eq [Microsoft.Win32.RegistryValueKind]::DWord) { $value = [int]$value }
        if ($kind -eq [Microsoft.Win32.RegistryValueKind]::QWord) { $value = [long]$value }
        if ($kind -eq [Microsoft.Win32.RegistryValueKind]::Binary) { $value = [byte[]]$value }
        if ($kind -eq [Microsoft.Win32.RegistryValueKind]::MultiString) { $value = [string[]]$value }
        $key.SetValue($entry.name, $value, $kind)
    }
}

function Save-UpdateJournal($Request, $Journal) { Write-UpdateJson (Join-Path $Request.stageDir 'transaction.json') $Journal $Request.stageDir }

function Get-UpdateRecoveryCommand($Request, [string]$TrustedScript) {
    $scriptPath = Assert-UpdateChild $TrustedScript $Request.stageDir
    $requestPath = Assert-UpdateChild (Join-Path $Request.stageDir 'request.json') $Request.stageDir
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $command = '"' + $powershell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $scriptPath + '" -RequestFile "' + $requestPath + '" -Recover'
    return $command
}

function Set-UpdateRecovery($Request, [string]$TrustedScript) {
    $command = Get-UpdateRecoveryCommand $Request $TrustedScript
    [void](New-Item -Path $script:UnknownAltRunOnceKey -Force)
    $existing = (Get-ItemProperty -LiteralPath $script:UnknownAltRunOnceKey -Name $script:UnknownAltRunOnceName -ErrorAction SilentlyContinue)
    if ($null -ne $existing -and $existing.($script:UnknownAltRunOnceName) -cne $command) { throw 'A different UnknownAlt recovery transaction is already pending.' }
    New-ItemProperty -LiteralPath $script:UnknownAltRunOnceKey -Name $script:UnknownAltRunOnceName -Value $command -PropertyType String -Force | Out-Null
    return $command
}

function Clear-UpdateRecovery([string]$ExpectedCommand) {
    $value = Get-ItemProperty -LiteralPath $script:UnknownAltRunOnceKey -Name $script:UnknownAltRunOnceName -ErrorAction SilentlyContinue
    if ($null -ne $value -and $value.($script:UnknownAltRunOnceName) -ceq $ExpectedCommand) { Remove-ItemProperty -LiteralPath $script:UnknownAltRunOnceKey -Name $script:UnknownAltRunOnceName }
}

function Write-UpdateOutcome($Request, [string]$Status, [string]$Message) {
    Write-UpdateJson $Request.outcomeFile ([ordered]@{ status=$Status; message=$Message; fromVersion=$Request.currentVersion; toVersion=$Request.expectedVersion; at=[DateTime]::UtcNow.ToString('o') }) $Request.defaultDataDir
}

function Show-UpdateRecoveryError([string]$Message) {
    # Hidden RunOnce recovery needs a visible last-resort result when it cannot recover safely.
    # This is never used for routine feed/network errors or a successfully restored installation.
    try { $shell = New-Object -ComObject WScript.Shell; [void]$shell.Popup($Message, 0, 'Unknown alt update recovery', 16) } catch { }
}

function Start-UpdateApp($Request, [switch]$Probe) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Request.currentExe; $start.WorkingDirectory = $Request.installDir; $start.UseShellExecute = $false
    [void]$start.EnvironmentVariables.Remove('UNKNOWNALT_UPDATE_HEALTH_FILE'); [void]$start.EnvironmentVariables.Remove('UNKNOWNALT_UPDATE_HEALTH_NONCE')
    if ($Probe) { $start.EnvironmentVariables['UNKNOWNALT_UPDATE_HEALTH_FILE'] = $Request.healthFile; $start.EnvironmentVariables['UNKNOWNALT_UPDATE_HEALTH_NONCE'] = $Request.healthNonce }
    return [Diagnostics.Process]::Start($start)
}

function Wait-UpdateHealth($Request, $Replacement) {
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        $Replacement.Refresh()
        if ($Replacement.HasExited) { throw 'The new UnknownAlt version did not stay open.' }
        if (Test-Path -LiteralPath $Request.healthFile) {
            try {
                $health = Read-UpdateJson $Request.healthFile 4096
                Assert-UpdateFields $health @('nonce','pid','version')
                if ($health.nonce -ceq $Request.healthNonce -and $health.pid -eq $Replacement.Id -and $health.version -ceq $Request.expectedVersion) { return $health }
                throw 'The new application returned a mismatched startup check.'
            } catch [System.IO.IOException] { }
        }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'The new UnknownAlt version did not finish its startup check.' }
        Start-Sleep -Milliseconds 100
    } while ($true)
}

function Stop-UpdateProbe($Replacement, $Identity) {
    if ($null -eq $Replacement -or $null -eq $Identity -or -not (Test-UpdateProcessAlive $Identity)) { return }
    $webviews = @(Get-UpdateWebViews $Replacement.Id)
    [void]$Replacement.CloseMainWindow()
    if (-not $Replacement.WaitForExit(10000) -and (Test-UpdateProcessAlive $Identity)) {
        # This is exclusively the helper-created, uncommitted probe. IPC mutations are gated.
        $Replacement.Kill(); [void]$Replacement.WaitForExit(10000)
    }
    if (Test-UpdateProcessAlive $Identity) { throw 'The uncommitted replacement could not be closed safely.' }
    Wait-UpdateProcesses $webviews 120
}

function Restore-UpdateTransaction($Request, $Journal) {
    Assert-UpdateNoApp $Request.currentExe
    $backup = Join-Path $Request.stageDir 'backup'
    if ($Journal.phase -ceq 'committed') { throw 'A committed update cannot be rolled back automatically.' }
    if ($Journal.probeStarted) {
        # Preserve the failed first-start state before any destructive restore. Snapshots remain.
        if (-not $Journal.dataPreserved) {
            $failedRoot = Join-Path $Request.stageDir ('failed-data-' + [guid]::NewGuid().ToString('N'))
            [void][IO.Directory]::CreateDirectory((Assert-UpdateChild $failedRoot $Request.stageDir))
            $failed = [ordered]@{ data=(Copy-UpdateTree $Request.dataDir (Join-Path $failedRoot 'data') $failedRoot); roaming=(Copy-UpdateTree $Journal.roamingDir (Join-Path $failedRoot 'roaming') $failedRoot) }
            if (-not (Test-UpdatePathEqual $Request.dataDir $Request.defaultDataDir)) { $failed.default = Copy-UpdateTree $Request.defaultDataDir (Join-Path $failedRoot 'default-data') $failedRoot }
            Write-UpdateJson (Join-Path $failedRoot 'snapshot.json') $failed $failedRoot
            $Journal.dataPreserved = $true; $Journal.failedDataDir = $failedRoot; Save-UpdateJournal $Request $Journal
        }
        Assert-UpdateTree (Join-Path $backup 'data') $Journal.data $Request.stageDir
        Assert-UpdateTree (Join-Path $backup 'roaming') $Journal.roaming $Request.stageDir
        if ($null -ne $Journal.defaultData) { Assert-UpdateTree (Join-Path $backup 'default-data') $Journal.defaultData $Request.stageDir }
    }
    $Journal.phase = 'rolling_back'; Save-UpdateJournal $Request $Journal
    Restore-UpdateManaged $Request.installDir (Join-Path $backup 'app') $Journal.managed $Request.stageDir
    Restore-UpdateRegistry $Journal.registry
    if ($Journal.probeStarted) {
        Restore-UpdateTree (Join-Path $backup 'data') $Journal.data $Request.dataDir $Request.stageDir
        Restore-UpdateTree (Join-Path $backup 'roaming') $Journal.roaming $Journal.roamingDir $Request.stageDir
        if ($null -ne $Journal.defaultData) { Restore-UpdateTree (Join-Path $backup 'default-data') $Journal.defaultData $Request.defaultDataDir $Request.stageDir }
    }
    Assert-UpdateBinary $Request.currentExe $Request.currentVersion
    $Journal.phase = 'rolled_back'; Save-UpdateJournal $Request $Journal
}

function Invoke-UnknownAltUpdate([string]$RequestPath, [switch]$Recovery, [switch]$OnlyValidate) {
    $request = $null; $journal = $null; $locks = @(); $pins = @(); $replacement = $null; $probeIdentity = $null; $parentStopped = $false; $mayHaveInstalled = $false; $recoveryCommand = ''; $validated = $false; $ackDelivered = $false; $commitDurable = $false; $recoveryError = ''
    try {
        $context = Get-UpdateContext
        $request = Read-UpdateJson $RequestPath 32768
        if ($Recovery -and [string]::IsNullOrEmpty($context.installLocation)) {
            # An interrupted Inno registration can be missing. Only the original own-key snapshot
            # in this exact private stage may recover the registered installation's path.
            $stagingRoot = Join-Path $context.localAppData 'UnknownAlt-update-staging'
            if (-not (Test-UpdatePathEqual ([IO.Path]::GetDirectoryName((Get-UpdatePath $request.stageDir))) $stagingRoot) -or -not (Test-UpdatePathEqual $RequestPath (Join-Path $request.stageDir 'request.json')) -or -not (Test-UpdatePathEqual $PSCommandPath (Join-Path $request.stageDir 'update-helper.ps1'))) { throw 'The interrupted installation registration cannot be recovered from this stage.' }
            $registrationJournal = Read-UpdateJson (Join-Path $request.stageDir 'transaction.json') 16000000
            $locations = @($registrationJournal.registry | Where-Object { $_.name -ceq 'InstallLocation' -and $_.kind -ceq 'String' })
            if ($registrationJournal.schema -ne 1 -or $registrationJournal.nonce -cne $request.healthNonce -or $locations.Count -ne 1) { throw 'The old UnknownAlt installation registration snapshot is invalid.' }
            $context.installLocation = $locations[0].value
        }
        [void](Assert-UpdateRequest $request $context -Recovery:$Recovery)
        $validated = $true
        if (-not (Test-UpdatePathEqual $RequestPath (Join-Path $request.stageDir 'request.json')) -or -not (Test-UpdatePathEqual $PSCommandPath (Join-Path $request.stageDir 'update-helper.ps1'))) { throw 'The trusted helper and request must be inside the same private stage.' }
        foreach ($file in @($RequestPath, $PSCommandPath, $request.manifestFile, $request.signatureFile, $request.installerFile)) { $pins += New-Object IO.FileStream((Get-UpdatePath $file), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read) }
        if ((Get-Item -LiteralPath $request.manifestFile).Length -gt 128000 -or (Get-Item -LiteralPath $request.signatureFile).Length -gt 4096) { throw 'The signed update metadata exceeds its bounded size limit.' }
        $manifest = Assert-UpdateManifest ([IO.File]::ReadAllBytes($request.manifestFile)) ([IO.File]::ReadAllText($request.signatureFile)) $script:UnknownAltChannel $request.expectedVersion $request.currentVersion
        Assert-UpdateInstaller $request.installerFile $manifest
        $metadata = [ordered]@{ stageDir=$request.stageDir; nonce=$request.healthNonce; helperPid=[Diagnostics.Process]::GetCurrentProcess().Id }
        $locks += Open-UpdateLock (Join-Path $request.stageDir 'transaction.lock') $request.stageDir $null
        $locks += Open-UpdateLock (Join-Path $request.installDir '.unknownalt-update.lock') $request.installDir $metadata
        if ($OnlyValidate) { if (-not $Recovery) { [void](Assert-UpdateParent $request); Assert-UpdateBinary $request.currentExe $request.currentVersion }; return }
        if ($Recovery) {
            $journal = Read-UpdateJson (Join-Path $request.stageDir 'transaction.json') 16000000
            if ($journal.schema -ne 1 -or $journal.nonce -cne $request.healthNonce -or $journal.roamingDir -cne (Join-Path $context.appData 'com.unknownalt.desktop')) { throw 'The recovery transaction does not match its trusted request.' }
            $recoveryCommand = $journal.recoveryCommand
            if ($recoveryCommand -cne (Get-UpdateRecoveryCommand $request $PSCommandPath)) { throw 'The recovery command does not match this stage.' }
            if ($journal.phase -in @('committed', 'rolled_back')) { Clear-UpdateRecovery $recoveryCommand; return }
            [void](Set-UpdateRecovery $request $PSCommandPath)
            $parentIdentity = [pscustomobject]@{ processId=$request.parentPid; start=[string]$request.parentStartFileTime; path=$request.currentExe }
            Wait-UpdateProcesses @($parentIdentity) 120
            Wait-UpdateInstaller $request
            if ($null -ne $journal.installerIdentity) { Wait-UpdateProcesses @($journal.installerIdentity) 120 }
            if ($null -ne $journal.probeIdentity -and (Test-UpdateProcessAlive $journal.probeIdentity)) {
                # Recovery cannot assume a formerly spawned process is still an uncommitted probe.
                throw 'Close UnknownAlt before recovering the interrupted update. Its backups are retained.'
            }
            Restore-UpdateTransaction $request $journal
            Clear-UpdateRecovery $recoveryCommand
            Write-UpdateOutcome $request 'rolled_back' 'The interrupted UnknownAlt update was recovered. Your previous version and saved data were restored.'
            $parentStopped = $true
        } else {
            $parentIdentity = Assert-UpdateParent $request; Assert-UpdateBinary $request.currentExe $request.currentVersion
            $webviews = @(Get-UpdateWebViews $request.parentPid)
            Write-UpdateJson $request.readyFile ([ordered]@{status='ready';nonce=$request.healthNonce}) $request.stageDir
            Wait-UpdateProcesses (@($parentIdentity) + $webviews) 120
            $parentStopped = $true
            Assert-UpdateNoApp $request.currentExe
            $backup = Join-Path $request.stageDir 'backup'; [void][IO.Directory]::CreateDirectory((Assert-UpdateChild $backup $request.stageDir))
            $journal = [pscustomobject][ordered]@{ schema=1; nonce=$request.healthNonce; phase='backing_up'; roamingDir=(Join-Path $context.appData 'com.unknownalt.desktop'); managed=@(); registry=@(); data=$null; roaming=$null; defaultData=$null; installerIdentity=$null; probeStarted=$false; probeIdentity=$null; dataPreserved=$false; failedDataDir=''; recoveryCommand='' }
            $journal.managed = @(Backup-UpdateManaged $request.installDir (Join-Path $backup 'app') $request.stageDir)
            $journal.registry = @(Backup-UpdateRegistry)
            $journal.data = Copy-UpdateTree $request.dataDir (Join-Path $backup 'data') $request.stageDir
            if (-not $journal.data.existed) { throw 'The active account data folder disappeared before backup.' }
            $journal.roaming = Copy-UpdateTree $journal.roamingDir (Join-Path $backup 'roaming') $request.stageDir
            if (-not (Test-UpdatePathEqual $request.dataDir $request.defaultDataDir)) { $journal.defaultData = Copy-UpdateTree $request.defaultDataDir (Join-Path $backup 'default-data') $request.stageDir }
            $journal.phase = 'backed_up'; Save-UpdateJournal $request $journal
            $recoveryCommand = Get-UpdateRecoveryCommand $request $PSCommandPath; $journal.recoveryCommand = $recoveryCommand
            $journal.phase = 'installing'; Save-UpdateJournal $request $journal
            [void](Set-UpdateRecovery $request $PSCommandPath)
            $mayHaveInstalled = $true
            $arguments = @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOCLOSEAPPLICATIONS','/NOFORCECLOSEAPPLICATIONS','/NORESTARTAPPLICATIONS',('/DIR="' + $request.installDir + '"'))
            $installer = Start-Process -FilePath $request.installerFile -ArgumentList $arguments -WindowStyle Hidden -PassThru
            $journal.installerIdentity = Get-UpdateProcessIdentity $installer.Id; Save-UpdateJournal $request $journal
            $installer.WaitForExit()
            if ($installer.ExitCode -ne 0) { throw 'The installer did not complete successfully.' }
            Assert-UpdateBinary $request.currentExe $request.expectedVersion
            $journal.phase = 'probing'; $journal.probeStarted = $true; Save-UpdateJournal $request $journal
            $replacement = Start-UpdateApp $request -Probe
            $probeIdentity = Get-UpdateProcessIdentity $replacement.Id; $journal.probeIdentity = $probeIdentity; Save-UpdateJournal $request $journal
            $health = Wait-UpdateHealth $request $replacement
            # Durable commit FIRST. After ACK the app may mutate data, so recovery must never undo it.
            $journal.phase = 'committed'; Save-UpdateJournal $request $journal
            $commitDurable = $true
            Write-UpdateOutcome $request 'success' ('UnknownAlt was updated to ' + $request.expectedVersion + '.')
            Write-UpdateJson ($request.healthFile + '.ack') $health $request.stageDir
            $ackDelivered = $true
            Clear-UpdateRecovery $recoveryCommand
            $parentStopped = $false
        }
    } catch {
        $detail = $_.Exception.Message
        if ($Recovery) { $recoveryError = 'UnknownAlt could not safely finish recovery. Close all UnknownAlt windows and reopen UnknownAlt to retry. Keep the update staging folder and its backups. If recovery still fails, restore using your saved backup before continuing.' }
        if ($validated) {
            try {
                if (-not $Recovery -and $null -ne $journal -and $journal.phase -ceq 'committed' -and -not $commitDurable) {
                    # A disk error may occur while persisting commit. Re-read its durable state
                    # before deciding whether rollback is allowed. Unknown state preserves data.
                    try {
                        $durable = Read-UpdateJson (Join-Path $request.stageDir 'transaction.json') 16000000
                        $commitDurable = ($durable.phase -ceq 'committed' -and $durable.nonce -ceq $request.healthNonce)
                        if (-not $commitDurable) { $journal.phase = 'probing' }
                    } catch { $commitDurable = $true }
                }
                if ($null -ne $journal -and $journal.phase -ceq 'committed') {
                    # There is no data rollback beyond durable commit. If ACK cannot be delivered,
                    # stop only the still-gated spawned probe and reopen the committed new version.
                    if (-not $ackDelivered) { Stop-UpdateProbe $replacement $probeIdentity; $parentStopped = $true }
                    Clear-UpdateRecovery $recoveryCommand
                    Write-UpdateOutcome $request 'failed' 'UnknownAlt installed successfully, but its final startup acknowledgement was interrupted. Reopen UnknownAlt; your data was retained.'
                } elseif ($mayHaveInstalled -and $null -ne $journal) {
                    Wait-UpdateInstaller $request
                    if ($null -ne $journal.installerIdentity) { Wait-UpdateProcesses @($journal.installerIdentity) 120 }
                    Stop-UpdateProbe $replacement $probeIdentity
                    Restore-UpdateTransaction $request $journal
                    Clear-UpdateRecovery $recoveryCommand
                    Write-UpdateOutcome $request 'rolled_back' 'The UnknownAlt update could not finish. Your previous version and saved data were restored.'
                } else {
                    if ($Recovery -and $null -ne $journal -and $journal.phase -notin @('committed','rolled_back')) { [void](Set-UpdateRecovery $request $PSCommandPath) }
                    if (-not $Recovery -and $null -ne $journal) {
                        # No installer was spawned: make a prepared journal terminal before reopening
                        # the unchanged app, even if RunOnce registration was denied.
                        $journal.phase = 'rolled_back'; Save-UpdateJournal $request $journal
                        Clear-UpdateRecovery $recoveryCommand
                    }
                    Write-UpdateOutcome $request 'failed' 'The UnknownAlt update stopped before installing. Your installed version and saved data were retained.'
                }
            } catch {
                # A failed rollback retains the signed payload, journal, old and failed-data snapshots.
                $parentStopped = $false
                $recoveryError = 'UnknownAlt could not safely restore the previous version. Close all UnknownAlt windows, then reopen UnknownAlt or restart Windows to retry recovery. Your recovery backups were retained in: ' + $request.stageDir + '. Keep these files until recovery succeeds.'
                if ($null -ne $journal -and $journal.phase -notin @('committed','rolled_back')) { try { [void](Set-UpdateRecovery $request $PSCommandPath) } catch { } }
                try { Write-UpdateOutcome $request 'failed' 'UnknownAlt could not finish recovering an update. Its recovery backups were retained. Close UnknownAlt and run the staged recovery helper before continuing.' } catch { }
            }
        }
        throw $detail
    } finally {
        foreach ($stream in $pins) { $stream.Dispose() }
        foreach ($stream in $locks) { $stream.Dispose() }
        if ($parentStopped -and $null -ne $request) { try { [void](Start-UpdateApp $request) } catch { } }
        if (-not [string]::IsNullOrEmpty($recoveryError)) { Show-UpdateRecoveryError $recoveryError }
    }
}

# Dot-sourcing is used only by isolated tests. Normal execution has no test bypass switches.
if ($MyInvocation.InvocationName -ne '.') {
    if ([string]::IsNullOrWhiteSpace($RequestFile)) { throw 'UnknownAlt update request missing.' }
    Invoke-UnknownAltUpdate $RequestFile -Recovery:$Recover -OnlyValidate:$ValidateOnly
}
