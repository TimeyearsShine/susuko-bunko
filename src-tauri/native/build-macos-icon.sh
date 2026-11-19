#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
output=target/macos-app-icon
mkdir -p "$output"
staging=$(mktemp -d "$output/compile.XXXXXX")
trap 'rm -rf "$staging"' EXIT

xcrun --sdk macosx actool \
    --compile "$staging" \
    --platform macosx \
    --minimum-deployment-target "${MACOSX_DEPLOYMENT_TARGET:-10.13}" \
    --target-device mac \
    --app-icon AppIcon \
    --output-partial-info-plist "$staging/Info.plist" \
    icons/AppIcon.icon

mv "$staging/AppIcon.icns" "$staging/Assets.car" "$output/"
