# Path remapping affects compiler diagnostics/debug records only. It does not
# change runtime data locations, cryptographic inputs or application features.
param([Parameter(Mandatory)][string]$SourceRoot)
$ErrorActionPreference='Stop'
$cargoHome=if($env:CARGO_HOME){$env:CARGO_HOME}else{Join-Path $env:USERPROFILE '.cargo'}
$target=if($env:CARGO_TARGET_DIR){$env:CARGO_TARGET_DIR}else{Join-Path $SourceRoot 'src-tauri\target'}
$rustup=if($env:RUSTUP_HOME){$env:RUSTUP_HOME}else{Join-Path $env:USERPROFILE '.rustup'}
$locations=[ordered]@{'unknownalt-source'=$SourceRoot;'unknownalt-cargo'=$cargoHome;'unknownalt-target'=$target;'unknownalt-user'=$env:USERPROFILE;'unknownalt-rust'=$rustup}
$roots=@($locations.Values)|Where-Object{$_}|ForEach-Object{[IO.Path]::GetFullPath($_).TrimEnd('\','/')}|Sort-Object -Unique
# MSVC's deterministic path mapping also remaps native __FILE__ diagnostics.
# Preserve caller flags and supply the same mapping to the AWS-LC CMake build.
$maps=@(foreach($entry in $locations.GetEnumerator()){if($entry.Value){'"/pathmap:'+([IO.Path]::GetFullPath($entry.Value).TrimEnd('\','/'))+'='+$entry.Key+'"'}}) -join ' '
$native="/experimental:deterministic $maps"
# _CL_ is applied after command-line options and is not copied into OpenSSL's
# compiler-flags version record. Distinct virtual roots avoid ambiguous PDB maps.
# SQLCipher uses this static OpenSSL without external configs/providers. Keep its
# unused default directories generic and prevent external configuration autoload.
$defaults='/DOPENSSL_NO_AUTOLOAD_CONFIG /DOPENSSLDIR=\"UnknownAlt-static\" /DENGINESDIR=\"UnknownAlt-static\" /DMODULESDIR=\"UnknownAlt-static\"'
$env:_CL_=(@($env:_CL_,$native,$defaults)|Where-Object{$_}) -join ' '
# A non-sensitive version marker makes Cargo invalidate native build caches when
# this build policy changes; actual computer paths never enter recorded CFLAGS.
$env:CFLAGS=(@($env:CFLAGS,'/DUNKNOWNALT_BUILD_PRIVACY_V1')|Where-Object{$_}) -join ' '
$env:CXXFLAGS=(@($env:CXXFLAGS,'/DUNKNOWNALT_BUILD_PRIVACY_V1')|Where-Object{$_}) -join ' '
$env:AWS_LC_SYS_CFLAGS=$env:CFLAGS
$env:AWS_LC_SYS_CXXFLAGS=$env:CXXFLAGS
# Avoid changing an already supplied broader Rust mapping: this preserves a
# clean build cache while still covering every default source/toolchain root.
$existing=@([regex]::Matches([string]$env:RUSTFLAGS,'--remap-path-prefix=(?:"([^"]+)"|([^ ]+))')|ForEach-Object{
 $value=if($_.Groups[1].Success){$_.Groups[1].Value}else{$_.Groups[2].Value}
 $value.Split('=')[0].TrimEnd('\','/')
})
foreach($root in $roots){
 $covered=@($existing|Where-Object{$root.Equals($_,[StringComparison]::OrdinalIgnoreCase) -or $root.StartsWith($_+'\',[StringComparison]::OrdinalIgnoreCase)}).Count -gt 0
 if(-not $covered){$env:RUSTFLAGS=([string]$env:RUSTFLAGS+' --remap-path-prefix="'+$root+'=unknownalt-build"').Trim()}
}
