//! Hivra for Windows and Linux: a small native shell around the Hivra website.
//!
//! Hivra's screens (Home, Launch, agents, computers, plans and billing) are
//! the website's own pages, so everything ships once and shows up here too.
//! The app adds what a browser tab can't: a window of its own with the
//! system's glass backdrop, sign-in through the person's browser (Google and
//! other providers refuse to run inside an app), hivra:// links and updates.
//!
//! The app's own pages (`ui/`) are the only ones that can call into the app.
//! Hivra's web pages get no access to it (see capabilities/default.json).

mod sign_in;

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

/// The website the app opens. A build can point at Canary with
/// HIVRA_DESKTOP_CONNECTION=https://canary.hermesos.cloud/dashboard.
const DEFAULT_CONNECTION: &str = "https://hivra.cloud/dashboard";

/// The website reads `HivraDesktop/<version>` as "inside the desktop app"
/// (dashboard/src/lib/desktop-shell.ts). Keep the rest of the user agent close
/// to the platform's real webview rather than masquerading as another shell.
#[cfg(windows)]
const USER_AGENT: &str = concat!(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ",
    "Chrome/142 Safari/537.36 Edg/142 HivraDesktop/",
    env!("CARGO_PKG_VERSION")
);
#[cfg(target_os = "linux")]
const USER_AGENT: &str = concat!(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) ",
    "Version/17.0 Safari/605.1.15 HivraDesktop/",
    env!("CARGO_PKG_VERSION")
);
#[cfg(not(any(windows, target_os = "linux")))]
const USER_AGENT: &str = concat!("HivraDesktop/", env!("CARGO_PKG_VERSION"));

fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        std::env::consts::OS
    }
}

struct Shell {
    connection: Url,
    /// Whether the website has browser sign-in switched on (None until asked).
    supported: Mutex<Option<bool>>,
    /// The person chose the website's own sign-in page instead.
    embedded: Mutex<bool>,
    pending: Mutex<Option<(sign_in::Request, sign_in::Intent)>>,
}

fn connection() -> Url {
    let raw = option_env!("HIVRA_DESKTOP_CONNECTION").unwrap_or(DEFAULT_CONNECTION);
    Url::parse(raw).unwrap_or_else(|_| Url::parse(DEFAULT_CONNECTION).expect("default connection"))
}

/// Whether an executable path can safely be written without quotes in a desktop
/// Exec key. This deliberately conservative subset covers normal install and
/// AppImage paths; unusual paths keep the plugin's spec-compliant quoting even
/// though xdg-utils' generic opener mishandles that quoting.
fn can_use_unquoted_desktop_exec(exec: &str) -> bool {
    !exec.is_empty()
        && exec
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-' | b'+' | b'@' | b'%'))
}

fn repair_desktop_exec(contents: &str, exec: &str) -> Option<String> {
    if !can_use_unquoted_desktop_exec(exec) {
        return None;
    }
    let quoted = format!("Exec=\"{exec}\" %u");
    contents
        .contains(&quoted)
        .then(|| contents.replacen(&quoted, &format!("Exec={exec} %u"), 1))
}

/// tauri-plugin-deep-link writes a spec-compliant quoted Exec path, but the
/// generic xdg-open fallback used by several Linux desktops does not implement
/// Exec quoting and then sends the callback to a browser instead of the app.
/// Rewrite simple paths to the compatible unquoted form after registration.
#[cfg(target_os = "linux")]
fn repair_linux_handler_exec(app: &AppHandle) -> Result<(), String> {
    let binary = tauri::utils::platform::current_exe().map_err(|error| error.to_string())?;
    let file_name = format!(
        "{}-handler.desktop",
        binary.file_name().and_then(|name| name.to_str()).ok_or("the executable has no UTF-8 file name")?
    );
    let exec = app
        .env()
        .appimage
        .clone()
        .unwrap_or_else(|| binary.into_os_string())
        .to_string_lossy()
        .into_owned();
    let target = app
        .path()
        .data_dir()
        .map_err(|error| error.to_string())?
        .join("applications")
        .join(&file_name);
    let contents = std::fs::read_to_string(&target).map_err(|error| error.to_string())?;
    let Some(repaired) = repair_desktop_exec(&contents, &exec) else { return Ok(()) };
    std::fs::write(&target, repaired).map_err(|error| error.to_string())?;

    // Newer xdg-utils validates the executable before writing the default. The
    // plugin invokes xdg-mime before this repair, so repeat the association now
    // that the desktop entry is in the compatible form.
    let status = std::process::Command::new("xdg-mime")
        .args(["default", &file_name, "x-scheme-handler/hivra"])
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("xdg-mime exited with {status}"))
    }
}

/// An address of the app's own pages, for navigating back to them.
fn local_page(page: &str) -> Url {
    let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    Url::parse(base).and_then(|base| base.join(page)).expect("local page")
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn show(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn navigate(app: &AppHandle, url: Url) {
    if let Some(window) = main_window(app) {
        let _ = window.navigate(url);
    }
}

fn fail(app: &AppHandle, message: &str) {
    let _ = app.emit_to("main", "sign-in-failed", message.to_string());
}

/// Asks the website once whether browser sign-in is on: a switched-off site
/// answers 404, a switched-on one refuses an empty request with 400.
async fn probe(app: AppHandle) {
    let shell = app.state::<Shell>();
    let Some(url) = sign_in::exchange_url(&shell.connection) else { return };
    let status = reqwest::Client::new()
        .post(url)
        .json(&serde_json::json!({}))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map(|response| response.status().as_u16());
    if let Ok(status) = status {
        *shell.supported.lock().unwrap() = Some(status == 400);
    }
}

#[tauri::command]
async fn open_hivra(app: AppHandle) {
    probe(app.clone()).await;
    let connection = app.state::<Shell>().connection.clone();
    navigate(&app, connection);
}

#[tauri::command]
fn begin_sign_in(app: AppHandle, intent: String) -> Result<(), String> {
    let shell = app.state::<Shell>();
    let intent = sign_in::Intent::parse(&intent);
    let request = sign_in::Request::new();
    let url = request
        .browser_url(&shell.connection, intent)
        .ok_or("This connection can't open browser sign-in.")?;
    *shell.pending.lock().unwrap() = Some((request, intent));
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|_| "Couldn't open your browser.".to_string())
}

#[tauri::command]
fn reopen_browser(app: AppHandle) -> Result<(), String> {
    let intent = app.state::<Shell>().pending.lock().unwrap().as_ref().map(|(_, intent)| *intent);
    match intent {
        Some(sign_in::Intent::SignUp) => begin_sign_in(app, "sign-up".into()),
        Some(sign_in::Intent::SignIn) => begin_sign_in(app, "sign-in".into()),
        None => Ok(()),
    }
}

#[tauri::command]
fn cancel_sign_in(app: AppHandle) {
    *app.state::<Shell>().pending.lock().unwrap() = None;
}

#[tauri::command]
fn use_embedded_sign_in(app: AppHandle) {
    let shell = app.state::<Shell>();
    *shell.embedded.lock().unwrap() = true;
    if let Ok(url) = shell.connection.join("/sign-in") {
        navigate(&app, url);
    }
}

fn take_matching_pending(
    pending: &mut Option<(sign_in::Request, sign_in::Intent)>,
    state: &str,
) -> Option<(sign_in::Request, sign_in::Intent)> {
    if pending.as_ref().is_some_and(|(request, _)| request.state == state) {
        pending.take()
    } else {
        None
    }
}

fn handle_link(app: &AppHandle, url: &Url) {
    let Some(callback) = sign_in::callback(url) else { return };
    show(app);
    let shell = app.state::<Shell>();
    let pending = take_matching_pending(&mut shell.pending.lock().unwrap(), &callback.state);
    let Some((request, _)) = pending else {
        fail(app, "That sign-in link is out of date. Please try again.");
        return;
    };
    let app = app.clone();
    let connection = shell.connection.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app.emit_to("main", "sign-in-finishing", ());
        match exchange(&connection, &callback.code, &request.verifier).await {
            Ok(finish) => navigate(&app, finish),
            Err(message) => fail(&app, &message),
        }
    });
}

async fn exchange(connection: &Url, code: &str, verifier: &str) -> Result<Url, String> {
    let url = sign_in::exchange_url(connection).ok_or("This connection can't finish browser sign-in.")?;
    let response = reqwest::Client::new()
        .post(url)
        .json(&serde_json::json!({ "code": code, "verifier": verifier }))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| "Couldn't reach Hivra. Check your connection and try again.".to_string())?;
    if response.status().as_u16() != 200 {
        return Err("That sign-in has expired. Please try again.".into());
    }
    let body: serde_json::Value = response.json().await.map_err(|_| "That sign-in has expired. Please try again.".to_string())?;
    let ticket = sign_in::ticket_from_response(&body).ok_or("That sign-in has expired. Please try again.")?;
    sign_in::finish_url(connection, &ticket).ok_or_else(|| "That sign-in has expired. Please try again.".into())
}

fn build_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let handle = app.clone();
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Hivra")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .user_agent(USER_AGENT)
        // Mica needs transparency on Windows. Linux WebKitGTK only composites a
        // transparent window reliably under a compositor, so it stays opaque there.
        .transparent(cfg!(windows))
        .initialization_script(format!(
            "document.documentElement.dataset.hivraPlatform='{}';",
            platform()
        ))
        .on_navigation(move |url| {
            let shell = handle.state::<Shell>();
            let supported = *shell.supported.lock().unwrap() == Some(true);
            let embedded = *shell.embedded.lock().unwrap();
            if supported && !embedded && sign_in::is_sign_in_page(url, &shell.connection) {
                // Our own welcome screen instead of the website's sign-in page.
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move { navigate(&handle, local_page("welcome.html")) });
                return false;
            }
            true
        })
        .build()?;
    #[cfg(windows)]
    {
        // Windows 11's Mica backdrop behind the app's own pages; older
        // Windows keeps the plain window colour.
        let _ = window_vibrancy::apply_mica(&window, None);
    }
    Ok(window)
}

fn check_for_updates(app: AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else { return };
        let Ok(Some(update)) = updater.check().await else { return };
        let version = update.version.clone();
        let handle = app.clone();
        app.dialog()
            .message(format!("Hivra {version} is ready. Restart now to update?"))
            .title("Update Hivra")
            .buttons(MessageDialogButtons::OkCancelCustom("Restart now".into(), "Later".into()))
            .show(move |restart| {
                if !restart {
                    return;
                }
                tauri::async_runtime::spawn(async move {
                    if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                        handle.restart();
                    }
                });
            });
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        // First, so a second launch (a hivra:// link) goes to the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    // Updates only in builds that carry the public key update files are signed with.
    let updates = option_env!("HIVRA_UPDATER_PUBKEY").filter(|key| !key.trim().is_empty());
    if let Some(key) = updates {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().pubkey(key).build());
    }

    builder
        .manage(Shell {
            connection: connection(),
            supported: Mutex::new(None),
            embedded: Mutex::new(false),
            pending: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            open_hivra,
            begin_sign_in,
            reopen_browser,
            cancel_sign_in,
            use_embedded_sign_in
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            #[cfg(any(windows, target_os = "linux"))]
            {
                // Installed builds register hivra:// at install; this covers
                // development and portable runs. A registration failure must not
                // take the app down, but it also must not be invisible.
                if let Err(error) = handle.deep_link().register("hivra") {
                    eprintln!("hivra: couldn't register the hivra:// browser handoff: {error}");
                }
                #[cfg(target_os = "linux")]
                if let Err(error) = repair_linux_handler_exec(&handle) {
                    eprintln!("hivra: couldn't repair the hivra:// browser handoff: {error}");
                }
            }
            let links = handle.clone();
            handle.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_link(&links, &url);
                }
            });
            build_window(&handle)?;
            if updates.is_some() {
                check_for_updates(handle.clone());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hivra");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_agent_carries_the_desktop_token_and_version() {
        assert!(USER_AGENT.contains(concat!("HivraDesktop/", env!("CARGO_PKG_VERSION"))));
        #[cfg(windows)]
        assert!(USER_AGENT.contains("Windows NT"));
        #[cfg(target_os = "linux")]
        assert!(!USER_AGENT.contains("Windows NT"));
    }

    #[test]
    fn platform_names_the_supported_desktop_os() {
        #[cfg(windows)]
        assert_eq!(platform(), "windows");
        #[cfg(target_os = "linux")]
        assert_eq!(platform(), "linux");
    }

    #[test]
    fn a_stale_callback_does_not_consume_the_current_sign_in() {
        let current = sign_in::Request { verifier: "verifier".into(), state: "current".into() };
        let mut pending = Some((current.clone(), sign_in::Intent::SignIn));

        assert_eq!(take_matching_pending(&mut pending, "stale"), None);
        assert_eq!(pending, Some((current.clone(), sign_in::Intent::SignIn)));
        assert_eq!(
            take_matching_pending(&mut pending, "current"),
            Some((current, sign_in::Intent::SignIn))
        );
        assert_eq!(pending, None);
    }

    #[test]
    fn simple_desktop_exec_paths_are_made_xdg_open_compatible() {
        let exec = "/home/ubuntu/Applications/Hivra_0.1.0_amd64.AppImage";
        let contents = format!("[Desktop Entry]\nExec=\"{exec}\" %u\nTerminal=false\n");
        assert_eq!(
            repair_desktop_exec(&contents, exec),
            Some(format!("[Desktop Entry]\nExec={exec} %u\nTerminal=false\n"))
        );
    }

    #[test]
    fn unusual_desktop_exec_paths_keep_spec_compliant_quoting() {
        for exec in ["/tmp/Hivra with spaces.AppImage", "/tmp/Hivra\\path.AppImage", "/tmp/Hivra\"quoted\".AppImage"] {
            let contents = format!("Exec=\"{exec}\" %u");
            assert_eq!(repair_desktop_exec(&contents, exec), None);
        }
    }
}
