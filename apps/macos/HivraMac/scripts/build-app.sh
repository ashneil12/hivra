#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
app_root="${script_dir:h}"
scratch_root="${HIVRA_MAC_BUILD_ROOT:-/tmp/hivra-mac-alpha-build}"
dist_root="${app_root}/dist"
app_bundle="${dist_root}/Hivra.app"
zip_path="${dist_root}/Hivra-Mac-Alpha.zip"
codesign_identity="${HIVRA_MAC_CODESIGN_IDENTITY:--}"

env CLANG_MODULE_CACHE_PATH="${scratch_root}/module-cache" \
  swift build \
  --package-path "${app_root}" \
  --scratch-path "${scratch_root}/swift" \
  -c release

if [[ "${app_bundle}" != "${app_root}/dist/Hivra.app" ]]; then
  print -u2 "Refusing to replace unexpected app bundle: ${app_bundle}"
  exit 1
fi

rm -rf "${app_bundle}"
rm -f "${zip_path}"
mkdir -p "${app_bundle}/Contents/MacOS" "${app_bundle}/Contents/Resources"
cp "${app_root}/Resources/Info.plist" "${app_bundle}/Contents/Info.plist"
cp "${app_root}/Resources/Hivra.icns" "${app_bundle}/Contents/Resources/Hivra.icns"
if source_revision="$(git -C "${app_root}" rev-parse HEAD 2>/dev/null)"; then
  /usr/libexec/PlistBuddy -c "Add :HivraSourceRevision string ${source_revision}" "${app_bundle}/Contents/Info.plist"
fi
cp "${scratch_root}/swift/release/HivraMac" "${app_bundle}/Contents/MacOS/HivraMac"
chmod 755 "${app_bundle}/Contents/MacOS/HivraMac"

codesign --force --deep --sign "${codesign_identity}" "${app_bundle}"
ditto -c -k --sequesterRsrc --keepParent "${app_bundle}" "${zip_path}"

print "Built ${app_bundle}"
print "Archive ${zip_path}"
