use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, RunEvent, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct SidecarState(Mutex<Option<CommandChild>>);

/// Shut the sidecar down gracefully so it can clean up its own children
/// (notably `llama-server`, which would otherwise be orphaned and keep the
/// bundled binary inside the .app open — blocking app delete/replace).
///
/// SIGTERM gives the Node sidecar's signal handlers a chance to run, which
/// in turn SIGTERM's each spawned llama-server. If that doesn't complete
/// inside `grace`, fall back to SIGKILL on the sidecar itself.
fn shutdown_sidecar(child: CommandChild) {
    let pid = child.pid();
    log::info!("Stopping sidecar (pid {pid})");

    #[cfg(unix)]
    {
        // libc::kill is FFI and requires unsafe. Necessary because the
        // safe Rust API (`child.kill()`) sends SIGKILL with no grace
        // period — that orphans the llama-server children the sidecar
        // owns. SIGTERM gives the Node sidecar's signal handlers a
        // chance to clean up before we fall back to SIGKILL below.
        // PID is captured from `child.pid()` (Tauri-managed), not from
        // user input — no injection surface.
        // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };

        let grace = std::time::Duration::from_secs(3);
        let start = std::time::Instant::now();
        let mut exited = false;
        while start.elapsed() < grace {
            // kill(pid, 0) probes liveness without sending a signal.
            // Same safety rationale as above.
            // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
            if unsafe { libc::kill(pid as i32, 0) } != 0 {
                exited = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        if exited {
            log::info!("Sidecar exited gracefully");
            return;
        }
        log::warn!("Sidecar didn't exit in {}s, sending SIGKILL", grace.as_secs());
    }

    let _ = child.kill();
}
struct ServerPortState(Mutex<Option<u16>>);

#[tauri::command]
fn get_server_port(state: tauri::State<'_, ServerPortState>) -> Option<u16> {
    *state.0.lock().unwrap()
}

/// Basic-auth credentials for the local Hono sidecar. Pushed from the
/// Node sidecar's stdout (`APP_API_KEY=` / `APP_API_SECRET=` lines) on
/// boot and held in process memory. Exposed only via the
/// `get_app_credentials` IPC command — never over HTTP — so a same-host
/// attacker or a DNS-rebound web page can't read them.
struct AppCredentialsState(Mutex<AppCredentials>);

#[derive(Default, Clone, serde::Serialize)]
struct AppCredentials {
    username: Option<String>,
    password: Option<String>,
}

#[tauri::command]
fn get_app_credentials(state: tauri::State<'_, AppCredentialsState>) -> AppCredentials {
    state.0.lock().unwrap().clone()
}

/// Reveal the log directory in Finder so users (and us debugging remotely)
/// can find the log file without knowing where it lives.
#[tauri::command]
fn reveal_logs(app: tauri::AppHandle) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("could not resolve log dir: {e}"))?;
    std::fs::create_dir_all(&log_dir).map_err(|e| format!("could not create log dir: {e}"))?;
    // macOS only for now — `open` reveals the folder in Finder.
    std::process::Command::new("open")
        .arg(&log_dir)
        .spawn()
        .map_err(|e| format!("failed to open log dir: {e}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Single-instance must come first so a second launch is short-
        // circuited before any state is initialized or a second sidecar
        // is spawned. The callback raises the existing window instead.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Log to a rotating file in ~/Library/Logs/Budget Itemizer/ on
        // macOS so users (and us debugging remotely) have something to
        // attach when reporting bugs. Kept under 5 MB with one rotated
        // backup. In dev builds we also tee to stdout/webview console.
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .targets({
                    let mut targets = vec![Target::new(TargetKind::LogDir { file_name: None })];
                    if cfg!(debug_assertions) {
                        targets.push(Target::new(TargetKind::Stdout));
                        targets.push(Target::new(TargetKind::Webview));
                    }
                    targets
                })
                .build(),
        )
        .manage(SidecarState(Mutex::new(None)))
        .manage(ServerPortState(Mutex::new(None)))
        .manage(AppCredentialsState(Mutex::new(AppCredentials::default())))
        .invoke_handler(tauri::generate_handler![
            get_server_port,
            get_app_credentials,
            reveal_logs
        ])
        // Red close-button = HIDE the window, never quit. The sidecar +
        // watcher + LLM stay running; the tray icon and dock icon stay
        // visible. Only an explicit Quit (Cmd+Q / app menu) shuts the
        // app down (via RunEvent::Exit → shutdown_sidecar). App is
        // macOS-only today but this behavior is sensible cross-platform
        // if it ever gets ported (users can still Quit via the app menu).
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {

            // Spawn sidecar server in release builds only.
            // In dev, the server runs separately via `npm run dev`.
            if !cfg!(debug_assertions) {
                let sidecar_command = app
                    .shell()
                    .sidecar("budget-itemizer-server")
                    .expect("failed to create sidecar command");

                let (mut rx, child) = sidecar_command
                    .spawn()
                    .expect("failed to spawn sidecar server");

                // Store child handle for cleanup
                let state = app.state::<SidecarState>();
                *state.0.lock().unwrap() = Some(child);

                // Capture app handle for the async task to store the port
                let app_handle = app.handle().clone();

                // Log sidecar output and parse port
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_shell::process::CommandEvent;
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(line) => {
                                let msg = String::from_utf8_lossy(&line);
                                let trimmed = msg.trim();
                                if let Some(port_str) = trimmed.strip_prefix("SERVER_PORT=") {
                                    if let Ok(port) = port_str.parse::<u16>() {
                                        let port_state = app_handle.state::<ServerPortState>();
                                        *port_state.0.lock().unwrap() = Some(port);
                                        log::info!("[server] bound to port {}", port);
                                    }
                                    log::info!("[server] {}", trimmed);
                                } else if let Some(value) = trimmed.strip_prefix("APP_API_KEY=") {
                                    let creds_state = app_handle.state::<AppCredentialsState>();
                                    creds_state.0.lock().unwrap().username = Some(value.to_string());
                                    // Redact the value from the log — the
                                    // log file lives in ~/Library/Logs/
                                    // and gets attached to bug reports.
                                    log::info!("[server] received app_api_key (len {})", value.len());
                                } else if let Some(value) = trimmed.strip_prefix("APP_API_SECRET=") {
                                    let creds_state = app_handle.state::<AppCredentialsState>();
                                    creds_state.0.lock().unwrap().password = Some(value.to_string());
                                    log::info!("[server] received app_api_secret (len {})", value.len());
                                } else {
                                    log::info!("[server] {}", trimmed);
                                }
                            }
                            CommandEvent::Stderr(line) => {
                                let msg = String::from_utf8_lossy(&line);
                                log::warn!("[server] {}", msg.trim());
                            }
                            CommandEvent::Terminated(status) => {
                                log::info!("[server] exited: {:?}", status);
                                // Clear cached creds and port — a future
                                // FE fetch via `get_app_credentials` will
                                // see `None` and the UI can surface a
                                // "sidecar died — relaunch app" screen
                                // instead of silently 401-looping with
                                // stale credentials.
                                let creds_state = app_handle.state::<AppCredentialsState>();
                                *creds_state.0.lock().unwrap() = AppCredentials::default();
                                let port_state = app_handle.state::<ServerPortState>();
                                *port_state.0.lock().unwrap() = None;
                                break;
                            }
                            CommandEvent::Error(err) => {
                                log::error!("[server] error: {}", err);
                                let creds_state = app_handle.state::<AppCredentialsState>();
                                *creds_state.0.lock().unwrap() = AppCredentials::default();
                                let port_state = app_handle.state::<ServerPortState>();
                                *port_state.0.lock().unwrap() = None;
                                break;
                            }
                            _ => {}
                        }
                    }
                });

                log::info!("Sidecar server started");
            }

            // Remove native decorations on Windows/Linux (custom titlebar in React)
            #[cfg(not(target_os = "macos"))]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
            }

            // Build tray icon with menu
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            // Quit (Cmd+Q / app menu) is the only path that gets here:
            // the close button is intercepted by on_window_event above
            // and the window is hidden instead. So reaching Exit really
            // does mean "user wants the app down."
            RunEvent::Exit => {
                let child = app_handle.state::<SidecarState>().0.lock().unwrap().take();
                if let Some(child) = child {
                    shutdown_sidecar(child);
                    log::info!("Sidecar server stopped");
                }
            }
            // macOS dock-icon click after the window was hidden by the
            // close button — bring the main window back into view.
            // Mirrors the tray-icon click handler. Without this the
            // dock click is silently dropped and the window is
            // unreachable until Quit-and-relaunch.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        }
    });
}
