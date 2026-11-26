#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::Manager;

struct ManagedBackendChild {
    child: Child,
    #[cfg(target_os = "windows")]
    _job: Option<win32::JobObjectGuard>,
}

struct BackendChildState(Arc<Mutex<Option<ManagedBackendChild>>>);

struct BackendWatchdogState {
    handle: Mutex<Option<JoinHandle<()>>>,
    shutdown_signal: Arc<(Mutex<bool>, Condvar)>,
}

static ACTIVE_BACKEND_PORT: AtomicU16 = AtomicU16::new(4173);
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

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

fn is_pos_backend_ready(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(200)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));

    let request = format!(
        "GET /api/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = Vec::with_capacity(4096);
    let mut chunk = [0u8; 1024];
    while response.len() < 16_384 {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                response.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&response);
                let has_http_200 =
                    text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200");
                if has_http_200
                    && (text.contains("\"profile\"") || text.contains("\"onboarded\""))
                {
                    return true;
                }
                if !text.starts_with("HTTP/1.") && response.len() >= 16 {
                    return false;
                }
            }
            Err(_) => break,
        }
    }

    let text = String::from_utf8_lossy(&response);
    let has_http_200 = text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200");
    has_http_200 && (text.contains("\"profile\"") || text.contains("\"onboarded\""))
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

fn resolve_instance_lock_path() -> PathBuf {
    let base = resolve_data_base_dir();
    let _ = fs::create_dir_all(&base);
    base.join("desktop-instance.json")
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

#[cfg(target_os = "windows")]
mod win32 {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    pub const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: u32 = 9;
    pub const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

    #[repr(C)]
    #[derive(Default)]
    pub struct JobObjectBasicLimitInformation {
        pub per_process_user_time_limit: i64,
        pub per_job_user_time_limit: i64,
        pub limit_flags: u32,
        pub minimum_working_set_size: usize,
        pub maximum_working_set_size: usize,
        pub active_process_limit: u32,
        pub affinity: usize,
        pub priority_class: u32,
        pub scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct IoCounters {
        pub read_operation_count: u64,
        pub write_operation_count: u64,
        pub other_operation_count: u64,
        pub read_transfer_count: u64,
        pub write_transfer_count: u64,
        pub other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct JobObjectExtendedLimitInformation {
        pub basic_limit_information: JobObjectBasicLimitInformation,
        pub io_info: IoCounters,
        pub process_memory_limit: usize,
        pub job_memory_limit: usize,
        pub peak_process_memory_used: usize,
        pub peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn CloseHandle(h_object: isize) -> i32;
        pub fn CreateMutexW(
            lp_mutex_attributes: *const c_void,
            b_initial_owner: i32,
            lp_name: *const u16,
        ) -> isize;
        pub fn GetLastError() -> u32;
        fn CreateJobObjectW(lp_job_attributes: *const c_void, lp_name: *const u16) -> isize;
        fn SetInformationJobObject(
            h_job: isize,
            job_object_information_class: u32,
            lp_job_object_information: *const c_void,
            cb_job_object_information_length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(h_job: isize, h_process: isize) -> i32;
    }

    pub struct JobObjectGuard(isize);

    impl Drop for JobObjectGuard {
        fn drop(&mut self) {
            if self.0 != 0 {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    pub fn assign_child_to_kill_on_close_job(child: &Child) -> Option<JobObjectGuard> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job == 0 {
                return None;
            }
            let mut info = JobObjectExtendedLimitInformation::default();
            info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok_set = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                (&info as *const JobObjectExtendedLimitInformation).cast::<c_void>(),
                std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
            );
            if ok_set == 0 {
                let _ = CloseHandle(job);
                return None;
            }
            let process_handle = child.as_raw_handle() as isize;
            let ok_assign = AssignProcessToJobObject(job, process_handle);
            if ok_assign == 0 {
                let _ = CloseHandle(job);
                return None;
            }
            Some(JobObjectGuard(job))
        }
    }
}

#[cfg(target_os = "windows")]
#[allow(dead_code)]
struct SingleInstanceMutexGuard(isize);

#[cfg(target_os = "windows")]
impl Drop for SingleInstanceMutexGuard {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                let _ = win32::CloseHandle(self.0);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn try_acquire_single_instance_mutex() -> (Option<SingleInstanceMutexGuard>, bool) {
    const ERROR_ALREADY_EXISTS: u32 = 183;
    let name: Vec<u16> = "Local\\RubeStockPosDesktopSingleInstance_v3_1\0"
        .encode_utf16()
        .collect();
    unsafe {
        let handle = win32::CreateMutexW(std::ptr::null(), 1, name.as_ptr());
        let already_running = win32::GetLastError() == ERROR_ALREADY_EXISTS;
        (Some(SingleInstanceMutexGuard(handle)), already_running)
    }
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
struct SingleInstanceMutexGuard;

#[cfg(not(target_os = "windows"))]
fn try_acquire_single_instance_mutex() -> (Option<SingleInstanceMutexGuard>, bool) {
    (Some(SingleInstanceMutexGuard), false)
}

fn notify_existing_instance_to_focus() {
    let lock_path = resolve_instance_lock_path();
    for attempt in 0..10 {
        if let Ok(raw) = fs::read_to_string(&lock_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(port) = parsed.get("wakeupPort").and_then(|v| v.as_u64()) {
                    if port > 0 && port <= u16::MAX as u64 {
                        let addr: SocketAddr = ([127, 0, 0, 1], port as u16).into();
                        if let Ok(mut stream) =
                            TcpStream::connect_timeout(&addr, Duration::from_millis(350))
                        {
                            let _ = stream.write_all(b"FOCUS\n");
                            return;
                        }
                    }
                }
            }
        }
        if attempt < 9 {
            thread::sleep(Duration::from_millis(50));
        }
    }
}

fn spawn_instance_wakeup_listener(app_handle_slot: Arc<Mutex<Option<tauri::AppHandle>>>) {
    let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) else {
        return;
    };
    let Ok(addr) = listener.local_addr() else {
        return;
    };
    let lock_path = resolve_instance_lock_path();
    let payload = serde_json::json!({
        "wakeupPort": addr.port(),
        "pid": std::process::id(),
    });
    let _ = fs::write(&lock_path, payload.to_string());

    let _ = thread::Builder::new()
        .name("rube-instance-wakeup".into())
        .spawn(move || {
            for stream in listener.incoming() {
                if SHUTTING_DOWN.load(Ordering::SeqCst) {
                    break;
                }
                if let Ok(mut sock) = stream {
                    let _ = sock.set_read_timeout(Some(Duration::from_millis(250)));
                    let mut buf = [0u8; 64];
                    let _ = sock.read(&mut buf);

                    for _ in 0..300 {
                        if SHUTTING_DOWN.load(Ordering::SeqCst) {
                            return;
                        }
                        let maybe_handle = app_handle_slot.lock().ok().and_then(|g| g.clone());
                        if let Some(app_handle) = maybe_handle {
                            if let Some(win) = app_handle.get_webview_window("main") {
                                let _ = win.unminimize();
                                let _ = win.show();
                                let _ = win.set_focus();
                                break;
                            }
                        }
                        thread::sleep(Duration::from_millis(50));
                    }
                }
            }
        });
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
) -> Option<ManagedBackendChild> {
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return None;
    }

    let script_path = app_root.join("scripts").join("start-pos-app.ts");
    let node_exe = find_node_executable(app_root);
    let log_path = resolve_backend_log_path();

    let (stdout_cfg, stderr_cfg) = match OpenOptions::new()
        .create(true)
        .append(true)
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
            #[cfg(target_os = "windows")]
            let job = win32::assign_child_to_kill_on_close_job(&child);

            for _ in 0..80 {
                if SHUTTING_DOWN.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                if let Ok(Some(_)) = child.try_wait() {
                    return None;
                }
                if is_pos_backend_ready(backend_port) {
                    break;
                }
                thread::sleep(Duration::from_millis(125));
            }

            if SHUTTING_DOWN.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            if let Ok(Some(_)) = child.try_wait() {
                return None;
            }

            Some(ManagedBackendChild {
                child,
                #[cfg(target_os = "windows")]
                _job: job,
            })
        }
        Err(_) => None,
    }
}

fn wait_or_shutdown(signal: &(Mutex<bool>, Condvar), duration: Duration) -> bool {
    let (lock, cvar) = signal;
    let Ok(mut stopped) = lock.lock() else {
        return SHUTTING_DOWN.load(Ordering::SeqCst);
    };
    let deadline = Instant::now() + duration;
    while !*stopped && !SHUTTING_DOWN.load(Ordering::SeqCst) {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        let (guard, result) = match cvar.wait_timeout(stopped, remaining) {
            Ok(res) => res,
            Err(poisoned) => poisoned.into_inner(),
        };
        stopped = guard;
        if result.timed_out() {
            break;
        }
    }
    *stopped || SHUTTING_DOWN.load(Ordering::SeqCst)
}

fn spawn_backend_watchdog(
    shared_child: Arc<Mutex<Option<ManagedBackendChild>>>,
    shutdown_signal: Arc<(Mutex<bool>, Condvar)>,
    app_root: PathBuf,
    db_path: PathBuf,
    backend_port: u16,
    demo_mode: bool,
) -> Option<JoinHandle<()>> {
    #[derive(PartialEq, Eq)]
    enum WatchdogAction {
        Idle,
        Restart,
        Abort,
    }

    thread::Builder::new()
        .name("rube-backend-watchdog".into())
        .spawn(move || {
            let mut consecutive_restarts: u32 = 0;
            let mut last_restart = Instant::now();

            loop {
                if wait_or_shutdown(&shutdown_signal, Duration::from_millis(1500)) {
                    break;
                }

                let action = {
                    if let Ok(mut guard) = shared_child.lock() {
                        match guard.as_mut() {
                            Some(managed) => match managed.child.try_wait() {
                                Ok(Some(_status)) => {
                                    *guard = None;
                                    if is_port_listening(backend_port) {
                                        WatchdogAction::Abort
                                    } else {
                                        WatchdogAction::Restart
                                    }
                                }
                                Ok(None) => WatchdogAction::Idle,
                                Err(_) => WatchdogAction::Idle,
                            },
                            None => {
                                if is_port_listening(backend_port) {
                                    WatchdogAction::Abort
                                } else {
                                    WatchdogAction::Restart
                                }
                            }
                        }
                    } else {
                        WatchdogAction::Idle
                    }
                };

                if action == WatchdogAction::Abort {
                    break;
                }
                if action != WatchdogAction::Restart || SHUTTING_DOWN.load(Ordering::SeqCst) {
                    continue;
                }

                if last_restart.elapsed() > Duration::from_secs(30) {
                    consecutive_restarts = 0;
                }
                consecutive_restarts = consecutive_restarts.saturating_add(1);
                let backoff_ms = (800u64 * consecutive_restarts as u64).min(3000);
                if wait_or_shutdown(&shutdown_signal, Duration::from_millis(backoff_ms)) {
                    break;
                }

                let new_child = spawn_local_pos_backend(
                    &app_root,
                    &db_path,
                    backend_port,
                    false,
                    demo_mode,
                );
                last_restart = Instant::now();
                if let Ok(mut guard) = shared_child.lock() {
                    if !SHUTTING_DOWN.load(Ordering::SeqCst) {
                        *guard = new_child;
                    } else if let Some(mut c) = new_child {
                        let _ = c.child.kill();
                        let _ = c.child.wait();
                    }
                }
            }
        })
        .ok()
}

fn kill_backend_child(app_handle: &tauri::AppHandle) {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    let _ = fs::remove_file(resolve_instance_lock_path());

    if let Some(watchdog) = app_handle.try_state::<BackendWatchdogState>() {
        let (lock, cvar) = &*watchdog.shutdown_signal;
        if let Ok(mut stopped) = lock.lock() {
            *stopped = true;
        }
        cvar.notify_all();
        let join_handle = watchdog.handle.lock().ok().and_then(|mut g| g.take());
        if let Some(handle) = join_handle {
            let _ = handle.join();
        }
    }

    if let Some(state) = app_handle.try_state::<BackendChildState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut managed) = guard.take() {
                let _ = managed.child.kill();
                let _ = managed.child.wait();
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

    let (_single_instance_mutex, already_running) = try_acquire_single_instance_mutex();
    if already_running {
        notify_existing_instance_to_focus();
        return;
    }

    let app_handle_slot: Arc<Mutex<Option<tauri::AppHandle>>> = Arc::new(Mutex::new(None));
    spawn_instance_wakeup_listener(Arc::clone(&app_handle_slot));

    let backend_port = pick_available_backend_port();
    ACTIVE_BACKEND_PORT.store(backend_port, Ordering::Relaxed);

    let backend_child = spawn_local_pos_backend(
        &app_root,
        &db_path,
        backend_port,
        clean_start_requested,
        demo_mode,
    );
    let shared_child = Arc::new(Mutex::new(backend_child));
    let watchdog_signal = Arc::new((Mutex::new(false), Condvar::new()));
    let watchdog_handle = spawn_backend_watchdog(
        Arc::clone(&shared_child),
        Arc::clone(&watchdog_signal),
        app_root.clone(),
        db_path.clone(),
        backend_port,
        demo_mode,
    );

    let app_handle_slot_for_setup = Arc::clone(&app_handle_slot);

    tauri::Builder::default()
        .manage(BackendChildState(Arc::clone(&shared_child)))
        .manage(BackendWatchdogState {
            handle: Mutex::new(watchdog_handle),
            shutdown_signal: watchdog_signal,
        })
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
            if let Ok(mut slot) = app_handle_slot_for_setup.lock() {
                *slot = Some(app.handle().clone());
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn test_win32_job_object_struct_layout() {
        use super::win32::{
            IoCounters, JobObjectBasicLimitInformation, JobObjectExtendedLimitInformation,
        };
        use std::mem::{align_of, offset_of, size_of};

        assert_eq!(size_of::<IoCounters>(), 48);
        assert_eq!(align_of::<IoCounters>(), 8);

        #[cfg(target_pointer_width = "64")]
        {
            assert_eq!(size_of::<JobObjectBasicLimitInformation>(), 64);
            assert_eq!(size_of::<JobObjectExtendedLimitInformation>(), 144);
            assert_eq!(
                offset_of!(JobObjectBasicLimitInformation, minimum_working_set_size),
                24
            );
            assert_eq!(offset_of!(JobObjectBasicLimitInformation, affinity), 48);
            assert_eq!(offset_of!(JobObjectExtendedLimitInformation, io_info), 64);
            assert_eq!(
                offset_of!(JobObjectExtendedLimitInformation, process_memory_limit),
                112
            );
        }

        #[cfg(target_pointer_width = "32")]
        {
            assert_eq!(size_of::<JobObjectBasicLimitInformation>(), 48);
            assert_eq!(size_of::<JobObjectExtendedLimitInformation>(), 112);
        }
    }

    #[test]
    fn test_bootstrap_probe_rejects_foreign_server_and_accepts_pos_bootstrap() {
        // Foreign non-POS HTTP server (404 / generic text) must be rejected
        let foreign_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let foreign_port = foreign_listener.local_addr().unwrap().port();
        let foreign_thread = thread::spawn(move || {
            if let Ok((mut sock, _)) = foreign_listener.accept() {
                let mut req = [0u8; 512];
                let _ = sock.read(&mut req);
                let _ = sock.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html>foreign</html>",
                );
            }
        });
        assert!(!is_pos_backend_ready(foreign_port));
        let _ = foreign_thread.join();

        // Valid POS /api/bootstrap server must be accepted
        let pos_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let pos_port = pos_listener.local_addr().unwrap().port();
        let pos_thread = thread::spawn(move || {
            if let Ok((mut sock, _)) = pos_listener.accept() {
                let mut req = [0u8; 512];
                let _ = sock.read(&mut req);
                let _ = sock.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"onboarded\":true,\"profile\":\"HYBRID\"}",
                );
            }
        });
        assert!(is_pos_backend_ready(pos_port));
        let _ = pos_thread.join();
    }
}
