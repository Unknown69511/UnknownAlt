# Isolated Windows PowerShell 5.1 tests. No real installer, app, registry key or user data is used.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$helperSource = Join-Path $sourceRoot 'src-tauri\update-helper.ps1'
$fixtureSource = Join-Path $sourceRoot 'src-tauri\fixtures\updater'
$testParent = [IO.Path]::GetDirectoryName($sourceRoot)
$testRoot = Join-Path $testParent ('helper-tests-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$assertions = 0

function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw ('Test failed: ' + $Message) }; $script:assertions++ }
function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $didThrow = $false
    try { & $Action | Out-Null } catch { $didThrow = $true }
    Assert-True $didThrow $Message
}
function Write-Fixture([string]$Path, [string]$Text) { [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)); [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false))) }
function Read-Fixture([string]$Path) { return [IO.File]::ReadAllText($Path) }

try {
    . $helperSource
    $channel = Read-UpdateJson (Join-Path $fixtureSource 'channel.json')
    $bytes = [IO.File]::ReadAllBytes((Join-Path $fixtureSource 'UnknownAlt-update.json'))
    $signature = Read-Fixture (Join-Path $fixtureSource 'UnknownAlt-update.json.sig')
    Assert-True (Test-UpdateSignature $bytes $signature $channel.publicKeyP256) 'Node publisher signatures verify with Windows CNG P1363.'
    $tampered = [byte[]]$bytes.Clone(); $tampered[10] = $tampered[10] -bxor 1
    Assert-True (-not (Test-UpdateSignature $tampered $signature $channel.publicKeyP256)) 'Changed raw manifest bytes fail verification.'
    Assert-Throws { Test-UpdateSignature $bytes 'invalid' $channel.publicKeyP256 } 'Invalid base64 fails closed.'
    $manifest = Assert-UpdateManifest $bytes $signature $channel '9.8.7' '9.8.6'
    Assert-Throws { Assert-UpdateManifest $bytes $signature $channel '9.8.7' '9.8.7' } 'Same version is rejected.'
    Assert-Throws { Assert-UpdateManifest $bytes $signature $channel '9.8.8' '9.8.6' } 'Unexpected target version is rejected.'
    $badChannel = $channel | ConvertTo-Json | ConvertFrom-Json; $badChannel.owner = 'InspectSoftware'
    Assert-Throws { Assert-UpdateManifest $bytes $signature $badChannel '9.8.7' '9.8.6' } 'Upstream owner is rejected.'
    $badChannel.owner = $channel.owner; $badChannel.repository = 'RoALT'
    Assert-Throws { Assert-UpdateManifest $bytes $signature $badChannel '9.8.7' '9.8.6' } 'Upstream repository is rejected.'
    Assert-Throws { Get-UpdateVersion '01.2.3' } 'Leading-zero versions are rejected.'
    Assert-Throws { Assert-UpdateChild (Join-Path $testRoot '..\outside') $testRoot } 'Canonical path traversal is rejected.'
    Assert-Throws { Get-UpdatePath 'C:\' } 'Drive root is rejected.'
    Assert-Throws { Get-UpdatePath 'C:\valid\file:stream' } 'Alternate data streams are rejected.'

    $jsonFile = Join-Path $testRoot 'atomic.json'
    Write-UpdateJson $jsonFile ([ordered]@{test='first'}) $testRoot
    Write-UpdateJson $jsonFile ([ordered]@{test='second'}) $testRoot
    Assert-True ((Read-UpdateJson $jsonFile).test -ceq 'second') 'Durable atomic JSON create/replace works on PS5.1.'
    Assert-Throws { Write-UpdateJson (Join-Path $testRoot 'oversized.json') @{test='too-long'} $testRoot 5 } 'Oversized recovery metadata is rejected before it can be persisted.'

    $tree = Join-Path $testRoot 'profile'
    $snapshot = Join-Path $testRoot 'snapshot'
    $progressFile = Join-Path $testRoot 'update-progress.json'
    Write-Fixture (Join-Path $tree 'webview\Local Storage\saved') 'profile'
    Write-Fixture (Join-Path $tree 'UnknownAlt.db') 'accounts'
    [void][IO.Directory]::CreateDirectory((Join-Path $tree 'empty'))
    [IO.File]::SetAttributes((Join-Path $tree 'UnknownAlt.db'), [IO.FileAttributes]::Hidden)
    Write-Fixture $progressFile '{}'
    $record = Copy-UpdateTree $tree $snapshot $testRoot ([pscustomobject]@{stageDir=$testRoot}) 3
    Assert-True ($record.files.Count -eq 2 -and 'empty' -in $record.directories) 'Snapshots include hidden files and empty directories.'
    Assert-True ((Read-UpdateJson $progressFile).current -eq 5) 'The progress counts only verified copies across snapshot roots.'
    Assert-UpdateTree $snapshot $record $testRoot
    Write-Fixture (Join-Path $snapshot 'webview\Local Storage\saved') 'altered'
    Assert-Throws { Assert-UpdateTree $snapshot $record $testRoot } 'Recovery rejects same-size tampering of a profile file.'
    $missing = Copy-UpdateTree (Join-Path $testRoot 'missing') (Join-Path $testRoot 'unused') $testRoot
    Assert-True (-not $missing.existed -and $missing.files.Count -eq 0) 'A missing optional profile keeps the existing journal shape.'

    # Exercise real recovery-marker code under StrictMode with in-memory registry-provider stubs.
    $script:mockRunOnce = $null
    function New-Item { param($Path,[switch]$Force) }
    function Get-ItemProperty { param($LiteralPath,$Name,$ErrorAction) if ($null -ne $script:mockRunOnce) { return [pscustomobject]@{UnknownAltUpdateRecovery=$script:mockRunOnce} } }
    function New-ItemProperty { param($LiteralPath,$Name,$Value,$PropertyType,[switch]$Force) $script:mockRunOnce=$Value }
    function Remove-ItemProperty { param($LiteralPath,$Name) $script:mockRunOnce=$null }
    $markerRequest = [pscustomobject]@{stageDir=$testRoot}
    $command = Set-UpdateRecovery $markerRequest (Join-Path $testRoot 'update-helper.ps1')
    Assert-True ($script:mockRunOnce -ceq $command) 'Production RunOnce registration uses the exact scoped dynamic property.'
    [void](Set-UpdateRecovery $markerRequest (Join-Path $testRoot 'update-helper.ps1'))
    $script:mockRunOnce='another-transaction'
    Assert-Throws { Set-UpdateRecovery $markerRequest (Join-Path $testRoot 'update-helper.ps1') } 'RunOnce does not overwrite another pending transaction.'
    Clear-UpdateRecovery $command
    Assert-True ($script:mockRunOnce -ceq 'another-transaction') 'Recovery cleanup does not remove another transaction marker.'
    $script:mockRunOnce=$command; Clear-UpdateRecovery $command
    Assert-True ($null -eq $script:mockRunOnce) 'Recovery cleanup removes only its matching marker.'
    Remove-Item Function:\New-Item,Function:\Get-ItemProperty,Function:\New-ItemProperty,Function:\Remove-ItemProperty

    # Managed-file rollback never replaces unrelated files and never touches the data folder.
    $install = Join-Path $testRoot 'managed-install'; $data = Join-Path $testRoot 'managed-data'; $backup = Join-Path $testRoot 'managed-backup'
    Write-Fixture (Join-Path $install 'UnknownAlt.exe') 'old-app'; Write-Fixture (Join-Path $install 'unins000.exe') 'old-uninstaller'
    Write-Fixture (Join-Path $install 'unrelated.txt') 'keep'; Write-Fixture (Join-Path $data 'UnknownAlt.db') 'accounts'
    $managed = @(Backup-UpdateManaged $install $backup $testRoot)
    Write-Fixture (Join-Path $install 'UnknownAlt.exe') 'new-app'; Write-Fixture (Join-Path $install 'unins001.dat') 'new-uninstaller'
    Restore-UpdateManaged $install $backup $managed $testRoot
    Assert-True ((Read-Fixture (Join-Path $install 'UnknownAlt.exe')) -ceq 'old-app') 'Owned executable restored.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $install 'unins001.dat'))) 'New owned uninstaller artifact removed on rollback.'
    Assert-True ((Read-Fixture (Join-Path $install 'unrelated.txt')) -ceq 'keep') 'Unrelated installation files retained.'
    Assert-True ((Read-Fixture (Join-Path $data 'UnknownAlt.db')) -ceq 'accounts') 'Managed rollback leaves account data unchanged.'
    Write-Fixture (Join-Path $backup 'UnknownAlt.exe') 'tampered'
    Assert-Throws { Restore-UpdateManaged $install $backup $managed $testRoot } 'Corrupt old executable backup aborts before replacing files.'

    # Exercise production probe shutdown ordering without creating or stopping any real process.
    $script:probeAlive=$true; $script:probeOrder=@()
    function Get-UpdateWebViews([int]$ParentProcessId) { $script:probeOrder+='capture'; return @([pscustomobject]@{processId=999;start='1';path='C:\fixture\webview.exe'}) }
    function Test-UpdateProcessAlive($Identity) { return $script:probeAlive }
    function Wait-UpdateProcesses([object[]]$Identities,[int]$Seconds=120) { Assert-True ($Identities.Count -eq 1 -and $Identities[0].processId -eq 999 -and -not $script:probeAlive) 'Probe WebViews are waited after its main process has exited.'; $script:probeOrder+='wait-webviews' }
    $probeMock=[pscustomobject]@{Id=888}
    $probeMock | Add-Member ScriptMethod CloseMainWindow { $script:probeOrder+='close'; return $true }
    $probeMock | Add-Member ScriptMethod WaitForExit { param($Milliseconds) return (-not $script:probeAlive) }
    $probeMock | Add-Member ScriptMethod Kill { $script:probeOrder+='kill-only-probe'; $script:probeAlive=$false }
    Stop-UpdateProbe $probeMock ([pscustomobject]@{processId=888;start='1';path='C:\fixture\UnknownAlt.exe'})
    Assert-True (($script:probeOrder -join ',') -ceq 'capture,close,kill-only-probe,wait-webviews') 'Probe shutdown captures descendants before closing and never kills them.'

    # Exercise the complete helper transaction with local fixtures and explicit side-effect stubs.
    # Each case re-sources a private staged helper, restoring original functions before mocking.
    foreach ($scenario in @('installer-failure','probe-failure','success','ack-failure','commit-failure','recovery-live-app','registration-failure')) {
        $caseRoot = Join-Path $testRoot $scenario
        $localRoot = Join-Path $caseRoot 'local'; $roamingRoot = Join-Path $caseRoot 'roaming'
        $caseStage = Join-Path $localRoot ('UnknownAlt-update-staging\unknownalt-update-' + [guid]::NewGuid().ToString())
        [void][IO.Directory]::CreateDirectory($caseStage)
        $caseInstall = Join-Path $localRoot 'Programs\UnknownAlt'; $defaultData = Join-Path $localRoot 'UnknownAlt'; $actualData = Join-Path $caseRoot 'custom-data'
        $caseRoaming = Join-Path $roamingRoot 'com.unknownalt.desktop'
        Write-Fixture (Join-Path $caseInstall 'UnknownAlt.exe') 'old-app'
        Write-Fixture (Join-Path $caseInstall 'UnknownAlt.ico') 'old-icon'
        Write-Fixture (Join-Path $caseInstall 'unins000.dat') 'old-uninstaller'
        Write-Fixture (Join-Path $caseInstall 'unrelated.txt') 'unrelated'
        Write-Fixture (Join-Path $actualData 'UnknownAlt.db') 'saved-accounts'
        Write-Fixture (Join-Path $actualData 'UnknownAlt.db.key') 'saved-key'
        Write-Fixture (Join-Path $actualData 'webview\Local Storage\settings') 'saved-settings'
        Write-Fixture (Join-Path $defaultData 'location.json') (([ordered]@{dataDir=$actualData} | ConvertTo-Json -Compress))
        Write-Fixture (Join-Path $caseRoaming 'window-state.json') 'saved-window'
        $stagedHelper = Join-Path $caseStage 'update-helper.ps1'
        $template = Read-Fixture $helperSource
        $template = $template.Replace('__UNKNOWNALT_PUBLIC_KEY__', $channel.publicKeyP256).Replace('__UNKNOWNALT_OWNER__', $channel.owner).Replace('__UNKNOWNALT_REPOSITORY__', $channel.repository).Replace('__UNKNOWNALT_CHANNEL__', $channel.channel)
        Write-Fixture $stagedHelper $template
        Copy-Item -LiteralPath (Join-Path $fixtureSource 'UnknownAlt-update.json') -Destination $caseStage
        Copy-Item -LiteralPath (Join-Path $fixtureSource 'UnknownAlt-update.json.sig') -Destination $caseStage
        $caseInstaller = Join-Path $caseStage 'UnknownAlt-Setup-9.8.7.exe'
        Copy-Item -LiteralPath (Join-Path $fixtureSource 'installer.bin') -Destination $caseInstaller
        . $stagedHelper
        $request = [pscustomobject][ordered]@{schema=1;parentPid=1234;parentStartFileTime='133000000000000000';currentVersion='9.8.6';currentExe=(Join-Path $caseInstall 'UnknownAlt.exe');installDir=$caseInstall;dataDir=$actualData;defaultDataDir=$defaultData;stageDir=$caseStage;expectedVersion='9.8.7';installerFile=$caseInstaller;manifestFile=(Join-Path $caseStage 'UnknownAlt-update.json');signatureFile=(Join-Path $caseStage 'UnknownAlt-update.json.sig');readyFile=(Join-Path $caseStage 'ready.json');outcomeFile=(Join-Path $defaultData 'update-result.json');healthFile=(Join-Path $caseStage 'health.json');healthNonce=[guid]::NewGuid().ToString()}
        $context = [pscustomobject]@{localAppData=$localRoot;appData=$roamingRoot;installLocation=$caseInstall}
        [void](Assert-UpdateRequest $request $context)
        Assert-True $true ('Full request validation: ' + $scenario)
        $badRequest = $request | ConvertTo-Json | ConvertFrom-Json; $badRequest.dataDir = $caseInstall
        Assert-Throws { Assert-UpdateRequest $badRequest $context } 'Installation/data overlap is rejected.'
        $badRequest.dataDir = $request.dataDir; $badRequest.manifestFile = Join-Path $caseRoot 'UnknownAlt-update.json'
        Assert-Throws { Assert-UpdateRequest $badRequest $context } 'Payload outside stage is rejected.'
        Assert-UpdateInstaller $caseInstaller $manifest
        [IO.File]::AppendAllText($caseInstaller, 'tamper')
        Assert-Throws { Assert-UpdateInstaller $caseInstaller $manifest } 'Changed installer size/hash is rejected.'
        Copy-Item -LiteralPath (Join-Path $fixtureSource 'installer.bin') -Destination $caseInstaller -Force
        Write-UpdateJson (Join-Path $caseStage 'request.json') $request $caseStage
        $progressFile = Join-Path $caseStage 'update-progress.json'
        Write-UpdateJson $progressFile ([ordered]@{ phase='backing-up' }) $caseStage
        $script:testContext = $context; $script:testRequest = $request; $script:testScenario = $scenario
        $script:recoveryRegistered = $false; $script:registryRestored = $false; $script:launches = @(); $script:probeStops = 0; $script:commitObserved = $false
        $script:recoveryDialogs = 0
        function Get-UpdateContext { return $script:testContext }
        function Show-UpdateRecoveryError([string]$Message) { $script:recoveryDialogs++ }
        function Save-UpdateJournal($Request,$Journal) { if ($script:testScenario -ceq 'commit-failure' -and $Journal.phase -ceq 'committed') { throw 'Mock durable commit write denied.' }; Write-UpdateJson (Join-Path $Request.stageDir 'transaction.json') $Journal $Request.stageDir }
        function Assert-UpdateParent($Request) { return [pscustomobject]@{processId=1234;start='133000000000000000';path=$Request.currentExe} }
        function Get-UpdateWebViews([int]$ParentProcessId) { return @() }
        function Wait-UpdateProcesses([object[]]$Identities, [int]$Seconds=120) { }
        function Wait-UpdateInstaller($Request) { }
        function Assert-UpdateNoApp([string]$Executable) { if ($script:testScenario -ceq 'recovery-live-app' -and $script:recovering) { throw 'Mock live app: never restore.' } }
        function Assert-UpdateBinary([string]$Executable, [string]$ExpectedVersion) { $wanted = 'old-app'; if ($ExpectedVersion -ceq '9.8.7') { $wanted='new-app' }; if ((Read-Fixture $Executable) -cne $wanted) { throw 'Mock executable metadata mismatch.' } }
        function Backup-UpdateRegistry { return @([pscustomobject]@{name='InstallLocation';kind='String';value=$script:testRequest.installDir}) }
        function Restore-UpdateRegistry($Record) { $script:registryRestored = $true }
        function Set-UpdateRecovery($Request, [string]$TrustedScript) { if ($script:testScenario -ceq 'registration-failure') { throw 'Mock RunOnce permission denied.' }; $script:recoveryRegistered=$true; return (Get-UpdateRecoveryCommand $Request $TrustedScript) }
        function Clear-UpdateRecovery([string]$ExpectedCommand) { $script:recoveryRegistered=$false }
        function Start-Process {
            param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru,[switch]$Wait)
            Assert-True ($WindowStyle -ceq 'Hidden') 'Installer is hidden.'
            Assert-True (($ArgumentList -contains '/NOFORCECLOSEAPPLICATIONS') -and ($ArgumentList -notcontains '/RELAUNCH')) 'Installer cannot force-close or independently relaunch.'
            Assert-True ($ArgumentList -contains ('/UNKNOWNALTPROGRESS=' + [IO.Path]::GetFileName($script:testRequest.stageDir).Substring('unknownalt-update-'.Length))) 'Silent installer receives its scoped window token.'
            $status = Read-UpdateJson (Join-Path $script:testRequest.stageDir 'update-progress.json') 4096
            Assert-True ($status.phase -ceq 'installing' -and $status.ownerPid -eq $PID) 'Helper owns the progress window before starting the installer.'
            Write-Fixture $script:testRequest.currentExe 'new-app'
            Write-Fixture (Join-Path $script:testRequest.installDir 'unins001.dat') 'new-uninstaller'
            $code=0; if ($script:testScenario -ceq 'installer-failure') { $code=1 }
            $mockInstaller = [pscustomobject]@{ExitCode=$code;Id=4567}
            $mockInstaller | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { }
            return $mockInstaller
        }
        function Start-UpdateApp($Request, [switch]$Probe) {
            $script:launches += [bool]$Probe
            if ($Probe) {
                $status = Read-UpdateJson (Join-Path $Request.stageDir 'update-progress.json') 4096
                Assert-True ($status.phase -ceq 'restarting') 'Restart status is written before opening the updated app.'
                Write-Fixture (Join-Path $Request.dataDir 'UnknownAlt.db') 'failed-new-accounts'
                Write-Fixture (Join-Path $Request.dataDir 'created-by-new') 'new-only-data'
                Write-Fixture (Join-Path $script:testContext.appData 'com.unknownalt.desktop\window-state.json') 'new-window'
            }
            return [pscustomobject]@{Id=5678}
        }
        function Get-UpdateProcessIdentity([int]$ProcessId) { return [pscustomobject]@{processId=$ProcessId;start='133000000000000001';path=$script:testRequest.currentExe} }
        function Test-UpdateProcessAlive($Identity) { return $false }
        function Stop-UpdateProbe($Replacement,$Identity) { $script:probeStops++ }
        function Wait-UpdateHealth($Request,$Replacement) {
            if ($script:testScenario -in @('probe-failure','recovery-live-app')) { throw 'Mock failed startup.' }
            if ($script:testScenario -ceq 'ack-failure') { [void][IO.Directory]::CreateDirectory($Request.healthFile + '.ack') }
            return [pscustomobject]@{nonce=$Request.healthNonce;pid=$Replacement.Id;version=$Request.expectedVersion}
        }
        $script:recovering=$false
        $failed=$false
        try { Invoke-UnknownAltUpdate (Join-Path $caseStage 'request.json') } catch { $failed=$true }
        $finalProgress = Read-UpdateJson $progressFile 4096
        if ($scenario -ceq 'success') {
            Assert-True ($finalProgress.phase -ceq 'completed') 'The window closes after successful startup acknowledgement.'
        } else {
            Assert-True ($finalProgress.phase -cin @('failed','rolled-back','recovery-needed')) 'Failed updates display a recovery outcome.'
        }
        $journal = Read-UpdateJson (Join-Path $caseStage 'transaction.json') 16000000
        if ($scenario -in @('installer-failure','probe-failure','commit-failure','recovery-live-app','registration-failure')) {
            Assert-True $failed ('Failed transaction reported: ' + $scenario)
            Assert-True ($journal.phase -ceq 'rolled_back') 'Failure durably records rollback.'
            Assert-True ((Read-Fixture $request.currentExe) -ceq 'old-app') 'Previous executable restored by complete transaction.'
            Assert-True ((Read-Fixture (Join-Path $actualData 'UnknownAlt.db')) -ceq 'saved-accounts') 'Full transaction preserves/restores account database.'
            Assert-True ((Read-Fixture (Join-Path $actualData 'UnknownAlt.db.key')) -ceq 'saved-key') 'Wrapped key retained.'
            Assert-True ((Read-Fixture (Join-Path $caseRoaming 'window-state.json')) -ceq 'saved-window') 'Window state retained/restored.'
            if ($scenario -ne 'registration-failure') { Assert-True $script:registryRestored 'Only owned uninstaller registration restored.' }
            Assert-True (-not $script:recoveryRegistered) 'Completed rollback clears its recovery marker.'
            Assert-True ($script:launches[-1] -eq $false) 'Previous version relaunched without probe environment.'
            if ($scenario -in @('probe-failure','commit-failure','recovery-live-app')) { Assert-True (Test-Path -LiteralPath (Join-Path $journal.failedDataDir 'data\created-by-new')) 'Failed first-start data retained before restoration.' }
        } else {
            Assert-True ($journal.phase -ceq 'committed') 'Success commits journal before acknowledgement.'
            Assert-True ((Read-Fixture $request.currentExe) -ceq 'new-app') 'Committed new executable kept.'
            Assert-True ((Read-Fixture (Join-Path $actualData 'UnknownAlt.db')) -ceq 'failed-new-accounts') 'Commit never rolls back new application data.'
            if ($scenario -ceq 'success') {
                Assert-True (-not $failed) 'Healthy transaction succeeds.'
                $ack = Read-UpdateJson ($request.healthFile + '.ack')
                Assert-True ($ack.nonce -ceq $request.healthNonce -and $ack.version -ceq '9.8.7' -and $ack.pid -eq 5678) 'ACK matches the healthy process.'
            } else {
                Assert-True $failed 'ACK write failure is reported.'
                Assert-True ($script:probeStops -eq 1 -and $script:launches[-1] -eq $false) 'Undeliverable ACK closes only the probe and reopens committed version.'
            }
            # Power-loss recovery past commit must not restore old data or binaries.
            $script:recovering=$true
            Invoke-UnknownAltUpdate (Join-Path $caseStage 'request.json') -Recovery
            Assert-True ((Read-Fixture (Join-Path $actualData 'UnknownAlt.db')) -ceq 'failed-new-accounts') 'Committed recovery never tears down application data.'
        }
        Assert-True ((Read-Fixture (Join-Path $caseInstall 'unrelated.txt')) -ceq 'unrelated') 'Complete transaction retains unrelated files.'
        if ($scenario -ceq 'recovery-live-app') {
            # Model an interrupted pre-commit transaction, then reject restoration while app is live.
            $journal.phase='installing'; Write-UpdateJson (Join-Path $caseStage 'transaction.json') $journal $caseStage
            Write-Fixture (Join-Path $actualData 'UnknownAlt.db') 'manual-live-account-change'
            $script:recovering=$true
            Assert-Throws { Invoke-UnknownAltUpdate (Join-Path $caseStage 'request.json') -Recovery } 'Recovery refuses a running manual app.'
            Assert-True ((Read-Fixture (Join-Path $actualData 'UnknownAlt.db')) -ceq 'manual-live-account-change') 'Recovery cannot overwrite data changed by a running manual app.'
            Assert-True $script:recoveryRegistered 'Blocked recovery rearms RunOnce.'
            Assert-True ($script:recoveryDialogs -eq 1) 'Irrecoverable hidden recovery reports a visible result.'
        }
    }
    Write-Output ('UnknownAlt helper tests passed: ' + $assertions + ' assertions (isolated fixtures only).')
} finally {
    # Windows recursive deletion is fenced against the explicitly created test workspace.
    $resolved = [IO.Path]::GetFullPath($testRoot).TrimEnd('\')
    $expectedParent = [IO.Path]::GetFullPath($testParent).TrimEnd('\')
    if ([IO.Path]::GetDirectoryName($resolved) -cne $expectedParent -or [IO.Path]::GetFileName($resolved) -notmatch '^helper-tests-[0-9a-f]{32}$') { throw 'Refusing cleanup outside the helper fixture workspace.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
