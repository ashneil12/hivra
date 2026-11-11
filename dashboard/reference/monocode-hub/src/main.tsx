import React, { useLayoutEffect } from "react";
import ReactDOM from "react-dom/client";
// TEMPORARY: remove with src/debugMonoScroll.ts.
if (import.meta.env.DEV) void import("./debugMonoScroll");
// A scripted Export / Import round trip in a dev slot (docs/PORTABLE.md); never in a build.
if (import.meta.env.DEV && import.meta.env.VITE_PORTABLE_PROOF) void import("./dev/portableProof");
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  activateWindowAppearance,
  initAppearance,
} from "./features/settings/model/appearance";
import { restoreSchemeAccent } from "./features/settings/model/themeSchemes";
import { initSounds } from "./features/settings/model/sounds";
import {
  abortQuit,
  askQuitConfirmation,
  commitQuit,
  loadBootWorkspace,
  reportQuitPoll,
} from "./app/model/appLifecycle";
import { homeDir } from "./platform/tauri/fs";
import { setHomeDir } from "./shared/lib/paths";
import { installNativeContextMenuGuard } from "./shared/lib/nativeContextMenu";
import { installTitleTips } from "./shared/lib/titleTips";
import { consumeInstalledUpdate } from "./app/model/updateNotice";
import { initializeProviderBinaryPaths } from "./features/providers/model/providerBinaryPaths";
// Lets file commands reach a connected machine for `remote://` paths.
import "./features/connections/model/remoteCommands";
import "./styles/index.css";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listenForEffortRefusals, setModelKeyStore, tauriModelKeyStore } from "./features/sessions/model/customModels";
import { hydrateRosterFromHome, enableTauriHome } from "./features/monos/model/monoHome";
import { setMonoHomeRoot } from "./features/hub/model/hubMcp";
import { DevRibbon } from "./app/shell/DevRibbon";
import { ChangeBar } from "./features/selfBuild/ui/ChangeBar";

// "Other models": in the app, keys go to the Keychain and key tests hit the provider (dev browser keeps the stub).
if (isTauri()) {
  setModelKeyStore(tauriModelKeyStore);
  // A level a provider refuses is marked for that model, so the picker can't show it as picked.
  void listenForEffortRefusals().catch(() => undefined);
}
// The Monos' roster and chat ids live in their home (~/agent-memory/monos for the daily app); the WebView keeps a cache.
if (isTauri()) {
  enableTauriHome();
  // Where this copy's Monos live, so its chats are fenced out of it too (hubMcp.ts monoHomeDeniedTools).
  void invoke<{ root: string }>("mono_home_info")
    .then((info) => setMonoHomeRoot(info.root))
    .catch(() => undefined);
}
const rosterReconciled = hydrateRosterFromHome().catch((error: unknown) => {
  console.error("Couldn't read the Monos' roster file; using the WebView's copy", error);
});

performance.mark("monocode:bootstrap");
// Let local boot IPC overlap loading/evaluating the workspace UI.
const appLoaded = import("./app/App");

initAppearance();
restoreSchemeAccent();
initSounds();
installNativeContextMenuGuard();
installTitleTips();
// Prime the real home directory before the first render so every `~/` file
// reference resolves consistently. The IPC call is local and failures remain
// best-effort, falling back to inference from a session's cwd.
const homeDirPrimed = homeDir()
  .then(setHomeDir)
  .catch(() => {});
const providerBinaryPathsPrimed = initializeProviderBinaryPaths().catch(
  () => undefined,
);

function dismissBootSplash() {
  const splash = document.getElementById("boot-splash");
  if (!splash || splash.dataset.dismissed === "1") return;
  splash.dataset.dismissed = "1";
  const fade = () => {
    activateWindowAppearance();
    splash.classList.add("boot-splash-out");
    window.setTimeout(() => {
      splash.remove();
      performance.mark("monocode:ui-ready");
      performance.measure("monocode:navigation-to-ui", {
        start: 0,
        end: "monocode:ui-ready",
      });
    }, 180);
  };
  // useLayoutEffect runs before paint. Two frames later the app is on
  // screen, so the fade reveals UI instead of the desktop blur.
  requestAnimationFrame(() => {
    requestAnimationFrame(fade);
  });
}

function BootGate({ children }: { children: React.ReactNode }) {
  useLayoutEffect(() => {
    dismissBootSplash();
  }, []);
  return children;
}

void listen<{ id: number; exempt: string | null }>("quit_poll", (event) => {
  void reportQuitPoll(event.payload.id, event.payload.exempt);
});
// Scoped to this window on purpose: a global `listen` is registered as `Any`,
// which Tauri matches for every event regardless of the emitter's target, so
// one dialog would become one per window.
void getCurrentWebviewWindow().listen<{ id: number; inFlight: number }>(
  "quit_confirm",
  (event) => {
    void askQuitConfirmation(event.payload.id, event.payload.inFlight);
  },
);
void listen<{ id: number; update: string | null }>("quit_commit", (event) => {
  void commitQuit(event.payload.id, event.payload.update);
});
void listen("quit_aborted", () => {
  abortQuit();
});

void Promise.all([
  homeDirPrimed,
  providerBinaryPathsPrimed,
  loadBootWorkspace(),
  appLoaded,
  rosterReconciled,
]).then(
  ([
    ,
    ,
    { windowTransfer, resumed, history, historyCwd },
    { default: App },
  ]) => {
    performance.mark("monocode:workspace-ready");
    const installedUpdate = windowTransfer ? null : consumeInstalledUpdate();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <BootGate>
          <App
            windowTransfer={windowTransfer}
            resumed={resumed}
            installedUpdate={installedUpdate}
            history={history}
            historyCwd={historyCwd}
          />
          <DevRibbon />
        </BootGate>
      </React.StrictMode>,
    );
    // What a Mono made and waits on Ash for (Now | Preview, Apply, Discard), in a root of its own: a previewed change
    // that breaks the app's own screens can't take these buttons with it (selfBuild/ui/ChangeBar.tsx).
    const bar = document.createElement("div");
    bar.dataset.changeBar = "";
    document.body.appendChild(bar);
    ReactDOM.createRoot(bar).render(<ChangeBar />);
  },
);
