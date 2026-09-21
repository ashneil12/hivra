# Omarchy virtual DRM cursor repair

This is a package-aware repair for the existing NODE-B / VM2099 Omarchy guest,
not a new image or automatic fresh-provisioning pipeline.

## Cause and boundary

Aquamarine 0.14.0 enables atomic DRM but never enables
`DRM_CLIENT_CAP_CURSOR_PLANE_HOTSPOT`. The kernel hides virtio's cursor plane
from that client. Hyprland falls back to a software cursor inside its monitor
framebuffer; capture's `PaintCursors=false` cannot remove those existing pixels.

Verified on VM2099: ordinary `modetest -M virtio_gpu -p` exposes cursor plane36;
`modetest -M virtio_gpu -a -p` does not. Hyprland's startup discovers primary35
only. Its `hardwareCursorsInUse` JSON is configured policy, not actual success.
The reversible `cursor:use_cpu_buffer=1` diagnostic failed and was restored2.

The patch enables the hotspot client capability after atomic support is enabled,
and sends available HOTSPOT_X/Y properties on visible cursor-shape updates.
Unsupported physical drivers retain their existing atomic behavior. No cursor
hiding, cursor metadata suppression, transport substitution, or desktop wipe.

Kernel contract: https://www.kernel.org/doc/html/v6.15/gpu/drm-uapi.html#drm-client-cap-cursor-plane-hotspot

## Pins

- Upstream `v0.14.0`: commit `a79fb21b2e2a82dd061a6d071802bcf38bd5c383`.
- Original `src/backend/drm/DRM.cpp` SHA256:
  `15a5717969fe1abb20e88496bd67bbe537515c3f69af8fb7c6b40dcd996fa7e4`.
- Previously installed package: `aquamarine 0.14.0-2`, SONAME13.
- Previously installed `/usr/lib/libaquamarine.so.0.14.0` SHA256:
  `996c0383167204db62b727e3d59aeae9de18ab74394280a3599ad3c221b97fbc`.
- Repair package: `aquamarine 0.14.0-2.1`, same SONAME13.

## Build and install (explicit operator authority required)

1. Copy this directory into a newly created, hivra-owned temporary directory on
   the guest. Preserve the original distro package for rollback first.
2. If CMake is absent, inspect `pacman -Sp cmake` and install only the missing
   build dependencies with `pacman -S --needed cmake`; never refresh/upgrade the
   whole guest for this repair. Existing make is sufficient; ninja is optional.
3. As non-root hivra, run `makepkg --cleanbuild --noconfirm` (without `-s` or `-i`).
   Source is pinned by full Git commit and patch by SHA256. Build parallelism2.
4. Inspect `.PKGINFO`, package file list, SONAME and SHA256. Install the exact
   resulting package through `pacman -U /absolute/path/aquamarine-0.14.0-2.1-x86_64.pkg.tar.zst`.
   Do not copy an untracked `.so` over `/usr/lib`.
5. End the browser test session normally, then restart the compositor through
   the normal desktop session path. Preserve user files, config and VM data.

After restart verify package ownership/version, new compositor revision/logs,
cursor plane discovery and active state, then the actual browser flow: one fast
cursor, cursor-shape changes, pointer/buttons/keyboard, resize, disconnect and
reconnect. Keep rollback package until acceptance. Remove only the explicitly
created temporary build directory after preserving package and evidence.

Build/install alone is not live acceptance. A distro upgrade may supersede this
local package; confirm the replacement includes both changes before removing
the repair pin. This recipe does not install anything automatically.

## Build evidence (2026-09-14)

Non-root `hivra` built the package on VM2099 in 57 seconds with makepkg exit0.
Patch validation and application passed. Package metadata provides SONAME13;
`readelf` confirms it and `ldd` reports no missing libraries.

- Built package SHA256:
  `87619dc2f86d67f2ea3608af965f786a9b3020563346eed1da36febbe56f42b1`.
- Built stripped library SHA256:
  `bf149b81fe472adf8f1fe59722ad39b59a090e9020ba56f7f1632fcfe051640b`.

These identify this build, not guaranteed byte-for-byte future makepkg builds.
No install/restart/live cursor acceptance is claimed by this build evidence.
