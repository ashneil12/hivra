# Hivra for Windows and Linux

A small native app around the Hivra website, built with
[Tauri](https://tauri.app) (Rust, with the operating system's webview for
pages). Hivra's screens (Home, Launch, agents, computers, plans and billing)
are the website's own pages, so every change to the website shows up here too.
The app adds what a browser tab can't:

- **Its own window** in the Hivra Glass design (`docs/brand/HIVRA-GLASS.md`).
  Windows 11 uses the system's Mica backdrop behind the app's own pages; Linux
  keeps an opaque window because WebKitGTK transparency depends on the user's
  compositor.
- **Sign-in through your browser.** Google and other providers refuse to run
  inside an app, so when the website asks you to sign in and it has
  `HIVRA_DESKTOP_BROWSER_SIGNIN` on, the app shows its own welcome screen
  (`ui/welcome.html`). **Get started free** or **I already have an account**
  opens your browser; after you sign in there, `hivra://auth/callback` brings
  you back and the app finishes the sign-in. It is the same hand-off as the Mac
  app, described in `dashboard/src/lib/desktop/browser-sign-in.ts`. **Sign in
  with email in this window instead** keeps the website's page.
- **hivra:// links**, delivered to the running app (one copy at a time). The
  installed packages declare the handler, and the app also registers it at
  runtime so development builds and portable AppImages can receive it.
- **Updates** through Tauri's updater, only in builds made with
  `HIVRA_UPDATER_PUBKEY` (the public key update files are signed with). Windows
  and Linux use separate `windows-updates` and `linux-updates` GitHub release
  feeds.

The website knows it is inside the app from the `HivraDesktop/<version>` part
of the user agent (`dashboard/src/lib/desktop-shell.ts`). The app does not add
its own navigation, so the website keeps its sidebar. Only the app's own pages
in `ui/` can call into the app; Hivra's web pages get no access to it
(`src-tauri/capabilities/default.json`).

## Build

On Windows with Rust (stable) and Node 22:

```powershell
cd apps/desktop/HivraDesktop/src-tauri
cargo test
npx @tauri-apps/cli@2.12.4 build --bundles nsis
```

The installer is `src-tauri/target/release/bundle/nsis/Hivra_<version>_x64-setup.exe`.
It installs for the current user (no administrator prompt) and fetches WebView2
if the PC lacks it.

On Debian/Ubuntu Linux, install Tauri's system dependencies first
(`libwebkit2gtk-4.1-dev`, GTK, `libayatana-appindicator3-dev`, `librsvg2-dev`,
`patchelf` and `xdg-utils`), then:

```bash
cd apps/desktop/HivraDesktop/src-tauri
cargo test
npx @tauri-apps/cli@2.12.4 build --bundles deb,appimage
```

The Debian package and AppImage are under
`src-tauri/target/release/bundle/{deb,appimage}/`. Build Linux releases on the
oldest supported distribution (Ubuntu 22.04 in CI) so the result does not
require a newer glibc than intended.

`HIVRA_DESKTOP_CONNECTION=https://canary.hermesos.cloud/dashboard` at build
time makes either platform's build open Canary. The **Windows app** and
**Linux app** GitHub workflows run the tests and build unsigned artifacts on
every pull request that touches this folder, and on demand. The Linux workflow
also starts the built app under Xvfb and checks that a real `Hivra` window is
created and painted; that smoke test proves the native shell starts, not the
interactive sign-in journey.

## Before a public release

- **Windows code signing.** Unsigned installers trigger Windows SmartScreen
  warnings. The release needs an Authenticode certificate, for example from
  Azure Trusted Signing, wired into the build's `bundle.windows.signCommand`.
- **Update signing.** A Tauri updater key pair (`tauri signer generate`): the
  private key signs update files in the release build
  (`TAURI_SIGNING_PRIVATE_KEY`, with `createUpdaterArtifacts` on), the public
  key goes in `HIVRA_UPDATER_PUBKEY`.
- **Real desktop validation.** CI can compile and smoke-test the shell, but
  release acceptance still needs a person to complete the browser hand-off on a
  real Windows PC and a real Linux desktop, including an AppImage/deep-link run
  outside the development environment.
- **The download buttons.** Publish Windows and Linux download addresses only
  when the appropriate artifacts exist, then configure the public download
  surfaces in `dashboard/src/lib/public-project-links.ts`.
