#!/bin/sh
set -eu

project_dir="${SRCROOT:?}"
tauri_dir="$(cd "$project_dir/../.." && pwd)"
if [ -r "$project_dir/.tauri/xcode-env.sh" ]; then
    . "$project_dir/.tauri/xcode-env.sh"
fi
export PATH="$PATH:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin"

# The Tauri CLI supplies build options for device, release and live-development builds.
if [ -f "$project_dir/.tauri/cli-options-server.json" ]; then
    exec node "$tauri_dir/../node_modules/@tauri-apps/cli/tauri.js" ios xcode-script \
        --platform "${PLATFORM_DISPLAY_NAME:?}" --sdk-root "${SDKROOT:?}" \
        --framework-search-paths "${FRAMEWORK_SEARCH_PATHS:-}" \
        --header-search-paths "${HEADER_SEARCH_PATHS:-}" \
        --gcc-preprocessor-definitions "${GCC_PREPROCESSOR_DEFINITIONS:-}" \
        --configuration "${CONFIGURATION:?}" ${FORCE_COLOR:-} ${ARCHS:?}
fi

# Xcode Run on a simulator can use the bundled frontend without a Tauri process.
case "$PLATFORM_NAME:$CONFIGURATION" in
    iphonesimulator:debug|iphonesimulator:Debug) ;;
    *) echo "error: Start the Tauri iOS CLI for device or release builds." >&2; exit 1 ;;
esac
for arch in ${ARCHS:?}; do
    case "$arch" in
        arm64) target=aarch64-apple-ios-sim ;;
        x86_64) target=x86_64-apple-ios ;;
        *) echo "error: Unsupported simulator architecture: $arch" >&2; exit 1 ;;
    esac
    cargo build --manifest-path "$tauri_dir/Cargo.toml" --target-dir "$tauri_dir/target" \
        --target "$target" --lib --features tauri/custom-protocol
    destination="$project_dir/Externals/$arch/$CONFIGURATION"
    mkdir -p "$destination"
    cp "$tauri_dir/target/$target/debug/libsusuko_bunko_lib.a" "$destination/libapp.a"
done
