#!/bin/zsh
# Builds Hivra.app.
#
#   ./scripts/build-app.sh                      internal build (ad-hoc signed, this Mac's architecture,
#                                               developer connections shown, no updater)
#   HIVRA_MAC_CHANNEL=release ./scripts/build-app.sh
#                                               public build: Apple silicon + Intel, Hivra only,
#                                               Developer ID signed; notarised and packed as a DMG
#                                               when HIVRA_MAC_NOTARY_PROFILE is set
#
# Settings (environment):
#   HIVRA_MAC_CODESIGN_IDENTITY   signing identity (default "-", ad-hoc). Required for release.
#   HIVRA_MAC_NOTARY_PROFILE      a `xcrun notarytool store-credentials` profile name.
#   HIVRA_SPARKLE_PUBLIC_KEY      Sparkle EdDSA public key; turns the updater on. Required for release.
set -euo pipefail

script_dir="${0:A:h}"
app_root="${script_dir:h}"
scratch_root="${HIVRA_MAC_BUILD_ROOT:-/tmp/hivra-mac-build}"
dist_root="${app_root}/dist"
app_bundle="${dist_root}/Hivra.app"
channel="${HIVRA_MAC_CHANNEL:-internal}"
codesign_identity="${HIVRA_MAC_CODESIGN_IDENTITY:--}"
notary_profile="${HIVRA_MAC_NOTARY_PROFILE:-}"
sparkle_key="${HIVRA_SPARKLE_PUBLIC_KEY:-}"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${app_root}/Resources/Info.plist")"

if [[ "${channel}" == "release" ]]; then
  if [[ "${codesign_identity}" == "-" ]]; then
    print -u2 "A release build needs HIVRA_MAC_CODESIGN_IDENTITY (a Developer ID Application identity)."
    exit 1
  fi
  if [[ -z "${sparkle_key}" ]]; then
    print -u2 "A release build needs HIVRA_SPARKLE_PUBLIC_KEY so installed copies can update."
    exit 1
  fi
  arch_flags=(--arch arm64 --arch x86_64)
else
  arch_flags=()
fi

swift_args=(--package-path "${app_root}" --scratch-path "${scratch_root}/swift" -c release ${arch_flags[@]})
env CLANG_MODULE_CACHE_PATH="${scratch_root}/module-cache" swift build ${swift_args[@]}
bin_path="$(swift build ${swift_args[@]} --show-bin-path)"

if [[ "${app_bundle}" != "${app_root}/dist/Hivra.app" ]]; then
  print -u2 "Refusing to replace unexpected app bundle: ${app_bundle}"
  exit 1
fi

rm -rf "${app_bundle}" "${dist_root}"/Hivra-*.zip "${dist_root}"/Hivra*.dmg "${dist_root}/Hivra-Mac-Alpha.zip"
mkdir -p "${app_bundle}/Contents/MacOS" "${app_bundle}/Contents/Resources" "${app_bundle}/Contents/Frameworks"
plist="${app_bundle}/Contents/Info.plist"
cp "${app_root}/Resources/Info.plist" "${plist}"
cp "${app_root}/Resources/Hivra.icns" "${app_bundle}/Contents/Resources/Hivra.icns"
if source_revision="$(git -C "${app_root}" rev-parse HEAD 2>/dev/null)"; then
  /usr/libexec/PlistBuddy -c "Add :HivraSourceRevision string ${source_revision}" "${plist}"
fi
if [[ "${channel}" == "release" ]]; then
  /usr/libexec/PlistBuddy -c "Add :HivraDeveloperConnections bool false" "${plist}"
fi
if [[ -n "${sparkle_key}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string ${sparkle_key}" "${plist}"
fi

cp "${bin_path}/HivraMac" "${app_bundle}/Contents/MacOS/HivraMac"
chmod 755 "${app_bundle}/Contents/MacOS/HivraMac"
ditto "${bin_path}/Sparkle.framework" "${app_bundle}/Contents/Frameworks/Sparkle.framework"
if ! otool -l "${app_bundle}/Contents/MacOS/HivraMac" | grep -q "@executable_path/../Frameworks"; then
  install_name_tool -add_rpath "@executable_path/../Frameworks" "${app_bundle}/Contents/MacOS/HivraMac"
fi

# Sign inside out: Sparkle's helpers, the framework, then the app (Sparkle's
# documented order for Developer ID builds). Hardened runtime throughout.
sign_flags=(--force --options runtime --sign "${codesign_identity}")
if [[ "${codesign_identity}" != "-" ]]; then sign_flags+=(--timestamp); fi
sparkle="${app_bundle}/Contents/Frameworks/Sparkle.framework"
codesign ${sign_flags[@]} "${sparkle}/Versions/B/XPCServices/Installer.xpc"
codesign ${sign_flags[@]} --preserve-metadata=entitlements "${sparkle}/Versions/B/XPCServices/Downloader.xpc"
codesign ${sign_flags[@]} "${sparkle}/Versions/B/Autoupdate"
codesign ${sign_flags[@]} "${sparkle}/Versions/B/Updater.app"
codesign ${sign_flags[@]} "${sparkle}"
codesign ${sign_flags[@]} "${app_bundle}"
codesign --verify --deep --strict "${app_bundle}"

update_zip="${dist_root}/Hivra-${version}.zip"
dmg="${dist_root}/Hivra.dmg"

if [[ -n "${notary_profile}" ]]; then
  ditto -c -k --sequesterRsrc --keepParent "${app_bundle}" "${dist_root}/notarize.zip"
  xcrun notarytool submit "${dist_root}/notarize.zip" --keychain-profile "${notary_profile}" --wait
  rm -f "${dist_root}/notarize.zip"
  xcrun stapler staple "${app_bundle}"
fi

# The archive installed copies update from (Sparkle), made after stapling.
ditto -c -k --sequesterRsrc --keepParent "${app_bundle}" "${update_zip}"

if [[ "${channel}" == "release" ]]; then
  staging="${scratch_root}/dmg"
  rm -rf "${staging}" && mkdir -p "${staging}"
  ditto "${app_bundle}" "${staging}/Hivra.app"
  ln -s /Applications "${staging}/Applications"
  hdiutil create -volname "Hivra" -srcfolder "${staging}" -ov -format ULFO "${dmg}" >/dev/null
  codesign --force --sign "${codesign_identity}" --timestamp "${dmg}"
  if [[ -n "${notary_profile}" ]]; then
    xcrun notarytool submit "${dmg}" --keychain-profile "${notary_profile}" --wait
    xcrun stapler staple "${dmg}"
    spctl --assess --type open --context context:primary-signature -v "${dmg}"
  fi
fi

print "Built ${app_bundle} (${channel}, ${version})"
print "Update archive ${update_zip}"
[[ -f "${dmg}" ]] && print "Installer ${dmg}"
exit 0
