#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

case "$(uname -s)" in
    Darwin)
        # Both slices are built before bundling. Existing Developer ID credentials can be
        # supplied using Tauri's APPLE_SIGNING_IDENTITY and notarization environment.
        rustup target add aarch64-apple-darwin x86_64-apple-darwin
        target=(--target universal-apple-darwin --bundles dmg)
        ;;
    Linux)
        target=(--bundles appimage,deb)
        ;;
    *)
        printf '%s\n' 'Run this script on a macOS or Linux build host.' >&2
        exit 1
        ;;
esac

# Distinct virtual paths prevent the build account and checkout from appearing in artifacts.
checkout=$(pwd -P)
registry="${CARGO_HOME:-$HOME/.cargo}"
rustup_root="${RUSTUP_HOME:-$HOME/.rustup}"
target_dir="${CARGO_TARGET_DIR:-$checkout/src-tauri/target}"
separator=$'\x1f'
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$checkout=unknownalt-source${separator}--remap-path-prefix=$registry=unknownalt-cargo${separator}--remap-path-prefix=$rustup_root=unknownalt-rust${separator}--remap-path-prefix=$target_dir=unknownalt-target${separator}--remap-path-prefix=$HOME=unknownalt-user"
export CFLAGS="${CFLAGS:-} \"-ffile-prefix-map=$checkout=unknownalt-source\" \"-ffile-prefix-map=$registry=unknownalt-cargo\""
export TZ=UTC LC_ALL=C SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1795305600}"
npm ci
npm run tauri -- build "${target[@]}" -- --locked
