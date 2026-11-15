; UnknownAlt for Windows: a per-user install of the app, no admin rights.
; Build it with scripts\build-installer.ps1, which passes the version from
; src-tauri\tauri.conf.json and where cargo put the release build.

#if Ver < EncodeVer(6,6,0)
  #error Inno Setup 6.6 or newer is needed (WizardStyle dynamic windows11)
#endif
#ifndef AppVersion
  #error Pass /DAppVersion=x.y.z, or build with scripts\build-installer.ps1
#endif
; VersionInfoVersion must be numeric; a prerelease such as 0.2.0-beta.1 passes 0.2.0 here.
#ifndef AppNumVersion
  #define AppNumVersion AppVersion
#endif
#ifndef AppExe
  #define AppExe "..\src-tauri\target\release\unknownalt.exe"
#endif
#ifndef WebView2Installer
  #error Pass /DWebView2Installer=<verified Microsoft runtime installer>, or use scripts\build-installer.ps1
#endif
#ifndef WebView2Sha256
  #error Pass /DWebView2Sha256=<SHA256 of the verified Microsoft runtime installer>
#endif

[Setup]
AppId={{25C70510-83BD-4A26-B6AA-7D831FC934F3}
AppName=Unknown alt
AppVersion={#AppVersion}
AppPublisher=Unknown alt
AppPublisherURL=https://github.com/Unknown69511/UnknownAlt
VersionInfoVersion={#AppNumVersion}
; Per-user: {autopf} is %LOCALAPPDATA%\Programs.
DefaultDirName={autopf}\UnknownAlt
UsePreviousAppDir=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
#ifdef OfflineRuntime
; This self-contained prerequisite payload is native x64, not ARM64.
ArchitecturesAllowed=x64compatible and not arm64
#else
; The small Microsoft bootstrapper selects the matching runtime architecture.
ArchitecturesAllowed=x64compatible
#endif
ArchitecturesInstallIn64BitMode=x64compatible
; Windows 10 1809, the oldest Windows Tauri 2 supports.
MinVersion=10.0.17763
WizardStyle=modern dynamic windows11
SetupIconFile=..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\UnknownAlt.exe
UninstallDisplayName=Unknown alt
; Updates wait for UnknownAlt to save and exit; never terminate a running app or game.
AppMutex=com.unknownalt.desktop-sim
CloseApplications=no
RestartApplications=no
OutputDir=..\dist-installer
#ifdef OfflineRuntime
OutputBaseFilename=UnknownAlt-Setup-{#AppVersion}-Windows-x64
#else
OutputBaseFilename=UnknownAlt-Setup-{#AppVersion}
#endif
Compression=lzma2/max
SolidCompression=yes

[Tasks]
Name: desktopicon; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#AppExe}"; DestDir: "{app}"; DestName: "UnknownAlt.exe"; Flags: ignoreversion
Source: "..\src-tauri\icons\icon.ico"; DestDir: "{app}"; DestName: "UnknownAlt.ico"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion
Source: "..\REBRANDING.md"; DestDir: "{app}"; Flags: ignoreversion
; Extracted only when needed, never copied into the app or its account-data folder.
Source: "{#WebView2Installer}"; DestDir: "{tmp}"; DestName: "UnknownAlt-WebView2-Prerequisite.exe"; Flags: dontcopy nocompression

[Icons]
Name: "{autoprograms}\UnknownAlt"; Filename: "{app}\UnknownAlt.exe"; IconFilename: "{app}\UnknownAlt.ico"
Name: "{autodesktop}\UnknownAlt"; Filename: "{app}\UnknownAlt.exe"; IconFilename: "{app}\UnknownAlt.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\UnknownAlt.exe"; Description: "{cm:LaunchProgram,Unknown alt}"; Flags: nowait postinstall skipifsilent; Check: WebView2Installed
; A maintainer may explicitly request relaunch after a local branded upgrade.
Filename: "{app}\UnknownAlt.exe"; Flags: nowait; Check: Relaunch

[Code]
const
  LegacyUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{F65209C5-78F5-4735-AE83-9F83EF9FCD83}_is1';
  OwnedUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{25C70510-83BD-4A26-B6AA-7D831FC934F3}_is1';
  WebView2Key = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Payload = 'UnknownAlt-WebView2-Prerequisite.exe';
  WebView2PayloadSha256 = '{#WebView2Sha256}';
  { tauri-plugin-single-instance holds <identifier>-sim while UnknownAlt runs. }
  RunningMutex = 'com.unknownalt.desktop-sim';

var
  LegacyUninstaller: String;
  LegacyBackup: String;

function WebView2Installed: Boolean; forward;

{ Install the signed prerequisite before changing any application files. The full
  build embeds the offline x64 runtime; ordinary update builds embed Microsoft's
  small architecture-selecting bootstrapper. Existing runtimes are left alone. }
function EnsureWebView2(var NeedsRestart: Boolean): String;
var
  PayloadPath: String;
  Code: Integer;
begin
  Result := '';
  if WebView2Installed then exit;
  try
    ExtractTemporaryFile(WebView2Payload);
    PayloadPath := ExpandConstant('{tmp}\') + WebView2Payload;
    if CompareText(GetSHA256OfFile(PayloadPath), WebView2PayloadSha256) <> 0 then begin
      Result := 'The Microsoft WebView2 runtime prerequisite failed verification. No application files were changed. Download a fresh Unknown alt installer.';
      exit;
    end;
    Log('Installing the bundled Microsoft Edge WebView2 Runtime prerequisite.');
    if not Exec(PayloadPath, '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, Code) then begin
      Result := 'Microsoft Edge WebView2 Runtime could not be started. No application files were changed. Please retry Unknown alt Setup.';
      exit;
    end;
    if Code = 3010 then begin
      NeedsRestart := True;
      Result := 'Microsoft Edge WebView2 Runtime needs Windows to restart. Restart Windows, then run Unknown alt Setup again. No application files were changed.';
      exit;
    end;
    if not WebView2Installed then begin
#ifdef OfflineRuntime
      Result := 'Microsoft Edge WebView2 Runtime did not finish installing (exit code ' + IntToStr(Code) + '). No application files were changed. Please retry Unknown alt Setup.';
#else
      Result := 'Microsoft Edge WebView2 Runtime did not finish installing (exit code ' + IntToStr(Code) + '). Connect to the internet and retry Unknown alt Setup, or use the full offline Windows x64 installer. No application files were changed.';
#endif
    end;
  except
    Result := 'The bundled Microsoft Edge WebView2 Runtime could not be prepared. No application files were changed. Please retry Unknown alt Setup.';
  end;
end;

function UninstallExe(CommandLine: String): String;
var
  I: Integer;
begin
  Result := Trim(CommandLine);
  if (Length(Result) > 1) and (Result[1] = '"') then begin
    Delete(Result, 1, 1);
    I := Pos('"', Result);
    if I > 0 then Result := Copy(Result, 1, I - 1);
  end;
end;

{ One-time migration of the prior local UnknownAlt registration. A separate RoALT
  installation is never touched. The new identity cannot be mistaken for RoALT's. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Name, Location, CommandLine, Candidate, Base, BackupDir: String;
begin
  Result := EnsureWebView2(NeedsRestart);
  if Result <> '' then exit;
  LegacyUninstaller := '';
  if RegQueryStringValue(HKCU, LegacyUninstallKey, 'DisplayName', Name) and
     (CompareText(Name, 'UnknownAlt') = 0) and
     RegQueryStringValue(HKCU, LegacyUninstallKey, 'InstallLocation', Location) and
     (CompareText(RemoveBackslashUnlessRoot(Location), RemoveBackslashUnlessRoot(ExpandConstant('{app}'))) = 0) and
     RegQueryStringValue(HKCU, LegacyUninstallKey, 'UninstallString', CommandLine) then begin
    Candidate := UninstallExe(CommandLine);
    Base := ExtractFileName(Candidate);
    if (CompareText(ExtractFileDir(Candidate), RemoveBackslashUnlessRoot(ExpandConstant('{app}'))) = 0) and
       (Length(Base) = 12) and (CompareText(Copy(Base, 1, 5), 'unins') = 0) and
       (Base[6] >= '0') and (Base[6] <= '9') and
       (Base[7] >= '0') and (Base[7] <= '9') and
       (Base[8] >= '0') and (Base[8] <= '9') and
       (CompareText(ExtractFileExt(Base), '.exe') = 0) and FileExists(Candidate) then begin
      BackupDir := ExpandConstant('{localappdata}\UnknownAlt-legacy-installer-backup\{#AppVersion}');
      if not ForceDirectories(BackupDir) then begin Result := 'Could not back up the previous Unknown alt installer.'; exit; end;
      LegacyBackup := AddBackslash(BackupDir) + Base;
      if not FileCopy(Candidate, LegacyBackup, False) then begin Result := 'Could not back up the previous Unknown alt uninstaller.'; exit; end;
      if FileExists(ChangeFileExt(Candidate, '.dat')) and
         not FileCopy(ChangeFileExt(Candidate, '.dat'), ChangeFileExt(LegacyBackup, '.dat'), False) then begin
        Result := 'Could not back up the previous Unknown alt uninstall log.'; exit;
      end;
      LegacyUninstaller := Candidate;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  NewCommand, NewUninstaller: String;
begin
  if (CurStep <> ssPostInstall) or (LegacyUninstaller = '') then exit;
  if RegQueryStringValue(HKCU, OwnedUninstallKey, 'UninstallString', NewCommand) then begin
    NewUninstaller := UninstallExe(NewCommand);
    { Do not remove the new log if Inno reused the same filename. }
    if CompareText(NewUninstaller, LegacyUninstaller) <> 0 then begin
      DeleteFile(LegacyUninstaller);
      DeleteFile(ChangeFileExt(LegacyUninstaller, '.dat'));
    end;
    RegDeleteKeyIncludingSubkeys(HKCU, LegacyUninstallKey);
  end;
end;

function HasWebView2(Root: Integer): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(Root, WebView2Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
end;

{ The machine-wide runtime (HKLM32 is WOW6432Node) or a per-user one. }
function WebView2Installed: Boolean;
begin
  Result := HasWebView2(HKLM32) or HasWebView2(HKCU);
end;

{ Optional maintainer-only relaunch for a local installer; the update helper owns its restart. }
function Relaunch: Boolean;
var
  I: Integer;
begin
  Result := False;
  if WizardSilent and WebView2Installed then
    for I := 1 to ParamCount do
      if CompareText(ParamStr(I), '/RELAUNCH') = 0 then
        Result := True;
end;

{ A running UnknownAlt holds its exe and database open: uninstalling then would leave both behind. }
function InitializeUninstall: Boolean;
begin
  Result := True;
  while Result and CheckForMutexes(RunningMutex) do
    Result := SuppressibleMsgBox('Unknown alt is running. Close it, then click OK.', mbError, MB_OKCANCEL, IDCANCEL) = IDOK;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  Data := ExpandConstant('{localappdata}\UnknownAlt');
  if (CurUninstallStep <> usPostUninstall) or UninstallSilent or not DirExists(Data) then
    exit;
  { Keep is the first button, so the default: TaskDialogMsgBox has no default-button flag. }
  if TaskDialogMsgBox('Also delete your Unknown alt accounts and settings?',
      'They are in ' + Data + '. Your Roblox accounts themselves are not affected.',
      mbConfirmation, MB_YESNO, ['&Keep them' #13#10 'They are there again if you reinstall Unknown alt.',
      '&Delete them' #13#10 'Saved accounts, cookies, groups and settings. This cannot be undone.'], 0) = IDNO then begin
    DelTree(Data, True, True, True);
    { The window position tauri-plugin-window-state keeps. }
    DelTree(ExpandConstant('{userappdata}\com.unknownalt.desktop'), True, True, True);
  end;
end;
