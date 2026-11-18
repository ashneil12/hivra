# Hivra for Windows

A small native app around the Hivra website, built with
[Tauri](https://tauri.app) (Rust, with the system's WebView2 for pages). Hivra's
screens (Home, Launch, agents, computers, plans and billing) are the website's
own pages, so every change to the website shows up here too. The app adds what
a browser tab can't:

- **Its own window** with Windows 11's Mica backdrop behind the app's own pages,
  in the Hivra Glass design (`docs/brand/HIVRA-GLASS.md`).
- **Sign-in through your browser.** Google and other providers refuse to run
  inside an app, so when the website asks you to sign in and it has
  `HIVRA_DESKTOP_BROWSER_SIGNIN` on, the app shows its own welcome screen
  (`ui/welcome.html`). **Get started free** or **I already have an account**
  opens your browser; after you sign in there, `hivra://auth/callback` brings
  you back and the app finishes the sign-in. It is the same hand-off as the Mac
  app, described in `dashboard/src/lib/desktop/browser-sign-in.ts`. **Sign in
  with email in this window instead** keeps the website's page.
- **hivra:// links**, delivered to the running app (one copy at a time).
- **Updates** through Tauri's updater, only in builds made with
  `HIVRA_UPDATER_PUBKEY` (the public key update files are signed with). The
  feed is `latest.json` on the `windows-updates` GitHub release.

The website knows it is inside the app from the `HivraDesktop/<version>` part
of the user agent (`dashboard/src/lib/desktop-shell.ts`). The app does not add
its own navigation, so the website keeps its sidebar. Only the app's own pages
in `ui/` can call into the app; Hivra's web pages get no access to it
(`src-tauri/capabilities/default.json`).

## Build

On Windows with Rust (stable) and Node 22:

```powershell
cd apps/windows/HivraDesktop/src-tauri
cargo test
npx @tauri-apps/cli@2.12.4 build --bundles nsis
```

The installer is `src-tauri/target/release/bundle/nsis/Hivra_<version>_x64-setup.exe`.
It installs for the current user (no administrator prompt) and fetches WebView2
if the PC lacks it. `HIVRA_DESKTOP_CONNECTION=https://canary.hermesos.cloud/dashboard`
at build time makes a build that opens Canary.

The **Windows app** GitHub workflow runs the tests and builds the unsigned
installer on every pull request that touches this folder, and on demand (with
an optional website address); the installer is kept as a run artifact for 14
days.

## Before a public release

- **Code signing.** Unsigned installers trigger Windows SmartScreen warnings.
  The release needs an Authenticode certificate, for example from Azure
  Trusted Signing, wired into the build's `bundle.windows.signCommand`.
- **Update signing.** A Tauri updater key pair (`tauri signer generate`): the
  private key signs update files in the release build
  (`TAURI_SIGNING_PRIVATE_KEY`, with `createUpdaterArtifacts` on), the public
  key goes in `HIVRA_UPDATER_PUBKEY`.
- **The download button.** The website lists only the Mac app today
  (`dashboard/src/lib/public-project-links.ts`); add Windows there when the
  first signed installer is published.
