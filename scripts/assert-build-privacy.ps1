param([Parameter(Mandatory)][string]$Executable,[Parameter(Mandatory)][string]$SourceRoot)
$ErrorActionPreference='Stop'
$file=Get-Item -LiteralPath $Executable
if($file.Length -gt 200000000 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unexpected release executable'}
$roots=@($SourceRoot,$env:USERPROFILE,$env:CARGO_HOME,$env:CARGO_TARGET_DIR,$env:RUSTUP_HOME)|Where-Object{$_}|ForEach-Object{[IO.Path]::GetFullPath($_).TrimEnd('\','/')}|Sort-Object -Unique
$bytes=[IO.File]::ReadAllBytes($file.FullName)
$issues=[Collections.Generic.HashSet[string]]::new()
foreach($encoding in @([Text.Encoding]::GetEncoding(28591),[Text.Encoding]::Unicode)){
 foreach($phase in @(0,1)){
  if($phase -eq 1 -and $encoding.CodePage -ne 1200){continue}
  $text=$encoding.GetString($bytes,$phase,$bytes.Length-$phase)
  foreach($root in $roots){foreach($variant in @($root,$root.Replace('\','/'),$root.Replace('\','\\'))){
   if($text.IndexOf($variant,[StringComparison]::OrdinalIgnoreCase) -ge 0){[void]$issues.Add('absolute build/profile path')}
  }}
  if($text -match '(?i)[A-Za-z]:[\\/][^\x00\r\n]{1,250}\.pdb'){[void]$issues.Add('absolute PDB metadata')}
 }
}
if($issues.Count){throw ('Release privacy check failed: '+(($issues|Sort-Object) -join ', ')+'. Rebuild affected native caches with the supplied path-mapping policy before packaging.')}
Write-Host 'Release build metadata check passed: no source/toolchain/profile roots or absolute PDB paths.'
