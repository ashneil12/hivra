#!/bin/zsh
# Publishes a release build made by `HIVRA_MAC_CHANNEL=release ./scripts/build-app.sh`
# (with HIVRA_MAC_NOTARY_PROFILE set) to GitHub Releases:
#
#   mac-v<version>   Hivra.dmg (the download) and Hivra-<version>.zip (the update)
#   mac-updates      appcast.xml, the feed installed copies check (SUFeedURL)
#
# The appcast is signed with the Sparkle EdDSA key in this Mac's Keychain
# (made once with Sparkle's generate_keys). Needs the GitHub CLI signed in.
# This makes the download public: run it only once the release is approved.
set -euo pipefail

script_dir="${0:A:h}"
app_root="${script_dir:h}"
dist_root="${app_root}/dist"
scratch_root="${HIVRA_MAC_BUILD_ROOT:-/tmp/hivra-mac-build}"
repo="${HIVRA_MAC_RELEASE_REPO:-ashneil12/hivra}"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${app_root}/Resources/Info.plist")"
tag="mac-v${version}"
dmg="${dist_root}/Hivra.dmg"
update_zip="${dist_root}/Hivra-${version}.zip"
generate_appcast="$(find "${scratch_root}/swift/artifacts" -path '*Sparkle/bin/generate_appcast' -type f | head -1)"

for file in "${dmg}" "${update_zip}"; do
  [[ -f "${file}" ]] || { print -u2 "Missing ${file}. Build a release first."; exit 1; }
done
xcrun stapler validate "${dmg}"
[[ -x "${generate_appcast}" ]] || { print -u2 "Sparkle's generate_appcast was not found under ${scratch_root}."; exit 1; }

updates="${scratch_root}/appcast"
rm -rf "${updates}" && mkdir -p "${updates}"
cp "${update_zip}" "${updates}/"
"${generate_appcast}" --download-url-prefix "https://github.com/${repo}/releases/download/${tag}/" "${updates}"

gh release create "${tag}" "${dmg}" "${update_zip}" --repo "${repo}" --latest=false \
  --title "Hivra for Mac ${version}" \
  --notes "Hivra for Mac ${version}. Download Hivra.dmg, open it and drag Hivra to Applications."
if ! gh release view mac-updates --repo "${repo}" >/dev/null 2>&1; then
  gh release create mac-updates --repo "${repo}" --latest=false --title "Hivra for Mac update feed" \
    --notes "The update feed installed copies of Hivra for Mac check. Download the app from the latest mac-v release."
fi
gh release upload mac-updates "${updates}/appcast.xml" --repo "${repo}" --clobber

print "Published ${tag}."
print "Download address: https://github.com/${repo}/releases/download/${tag}/Hivra.dmg"
