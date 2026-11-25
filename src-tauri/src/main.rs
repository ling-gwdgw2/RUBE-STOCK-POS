#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::fs::{self, OpenOptions};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::Manager;

struct BackendChildState(Mutex<Option<Child>>);
static ACTIVE_BACKEND_PORT: AtomicU16 = AtomicU16::new(4173);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopShellInfo {
    is_tauri: bool,
    kiosk_mode: bool,
    api_base_url: String,
    db_path: String,
}

fn is_port_listening(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn pick_available_backend_port() -> u16 {
    for port in 4173..=4195 {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) {
        if let Ok(addr) = listener.local_addr() {
            return addr.port();
        }
    }
    4173
}

fn resolve_app_root() -> PathBuf {
    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            if exe_dir.join("scripts").join("start-pos-app.ts").exists() {
                return exe_dir.to_path_buf();
            }
            if let Some(parent) = exe_dir.parent() {
                if parent.join("scripts").join("start-pos-app.ts").exists() {
                    return parent.to_path_buf();
                }
            }
        }
    }
    env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn resolve_data_base_dir() -> PathBuf {
    let base_dir = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    base_dir.join("RubeStockPOS")
}

fn resolve_production_db_path() -> PathBuf {
    let data_dir = resolve_data_base_dir().join("data");
    let _ = fs::create_dir_all(&data_dir);
    data_dir.join("rube_pos_live.db")
}

fn resolve_backend_log_path() -> PathBuf {
    let logs_dir = resolve_data_base_dir().join("logs");
    let _ = fs::create_dir_all(&logs_dir);
    logs_dir.join("backend.log")
}

fn find_node_executable(app_root: &Path) -> PathBuf {
    let bundled = app_root.join("runtime").join("node.exe");
    if bundled.exists() {
        return bundled;
    }
    let system_node = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
    if system_node.exists() {
        return system_node;
    }
    PathBuf::from("node")
}

fn spawn_local_pos_backend(
    app_root: &Path,
    db_path: &Path,
    backend_port: u16,
    clean_start: bool,
    demo_mode: bool,
) -> Option<Child> {
    let script_path = app_root.join("scripts").join("start-pos-app.ts");
    let node_exe = find_node_executable(app_root);
    let log_path = resolve_backend_log_path();

    let (stdout_cfg, stderr_cfg) = match OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
    {
        Ok(file) => match file.try_clone() {
            Ok(cloned) => (Stdio::from(file), Stdio::from(cloned)),
            Err(_) => (Stdio::from(file), Stdio::null()),
        },
        Err(_) => (Stdio::null(), Stdio::null()),
    };

    let mut cmd = Command::new(&node_exe);
    cmd.current_dir(app_root)
        .arg(&script_path)
        .env("PORT", backend_port.to_string())
        .env("RUBE_POS_DB_PATH", db_path)
        .env("RUBE_DEMO_SEED", if demo_mode && !clean_start { "1" } else { "0" })
        .stdout(stdout_cfg)
        .stderr(stderr_cfg);

    if clean_start {
        cmd.env("RUBE_POS_CLEAN_START", "1");
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.spawn() {
        Ok(mut child) => {
            for _ in 0..80 {
                if let Ok(Some(_)) = child.try_wait() {
                    return None;
                }
                if is_port_listening(backend_port) {
                    break;
                }
                thread::sleep(Duration::from_millis(125));
            }
            Some(child)
        }
        Err(_) => None,
    }
}

fn kill_backend_child(app_handle: &tauri::AppHandle) {
    if let Some(state) = app_handle.try_state::<BackendChildState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[tauri::command]
fn toggle_kiosk_fullscreen(window: tauri::Window, enable: Option<bool>) -> Result<bool, String> {
    let current = window.is_fullscreen().map_err(|e| e.to_string())?;
    let next = enable.unwrap_or(!current);
    window.set_fullscreen(next).map_err(|e| e.to_string())?;
    Ok(next)
}

#[tauri::command]
fn get_desktop_shell_info(window: tauri::Window) -> DesktopShellInfo {
    let db_path = resolve_production_db_path();
    let kiosk_mode = window.is_fullscreen().unwrap_or(false);
    let port = ACTIVE_BACKEND_PORT.load(Ordering::Relaxed);
    DesktopShellInfo {
        is_tauri: true,
        kiosk_mode,
        api_base_url: format!("http://127.0.0.1:{port}"),
        db_path: db_path.to_string_lossy().into_owned(),
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let check_only = args.iter().any(|a| a == "--check-only");
    let kiosk_requested = args.iter().any(|a| a == "--kiosk");
    let clean_start_requested = args.iter().any(|a| a == "--clean-start")
        || env::var("RUBE_POS_CLEAN_START").ok().as_deref() == Some("1");
    let demo_mode = args.iter().any(|a| a == "--demo");

    let app_root = resolve_app_root();
    let db_path = resolve_production_db_path();

    if check_only {
        let _ = find_node_executable(&app_root);
        return;
    }

    let backend_port = pick_available_backend_port();
    ACTIVE_BACKEND_PORT.store(backend_port, Ordering::Relaxed);

    let backend_child = spawn_local_pos_backend(
        &app_root,
        &db_path,
        backend_port,
        clean_start_requested,
        demo_mode,
    );

    tauri::Builder::default()
        .manage(BackendChildState(Mutex::new(backend_child)))
        .setup(move |app| {
            let init_script = format!("window.__RUBE_API_BASE__ = 'http://127.0.0.1:{backend_port}';");
            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("RUBE-STOCK-POS v3.1 — ระบบขายหน้าร้านและคลังสินค้าอัจฉริยะ")
            .inner_size(1366.0, 840.0)
            .min_inner_size(1024.0, 700.0)
            .resizable(true)
            .initialization_script(&init_script);

            if kiosk_requested {
                builder = builder.fullscreen(true);
            } else {
                builder = builder.maximized(true);
            }

            let win = builder.build()?;
            let _ = win.set_focus();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            toggle_kiosk_fullscreen,
            get_desktop_shell_info
        ])
        .build(tauri::generate_context!())
        .expect("Failed to build RUBE-STOCK-POS Tauri v2 application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } if label == "main" => {
                kill_backend_child(app_handle);
            }
            tauri::RunEvent::Exit => {
                kill_backend_child(app_handle);
            }
            _ => {}
        });
}
