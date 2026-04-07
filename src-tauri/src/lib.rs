use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use url::Url;
pub mod sandbox;
use sandbox::{
    run_command,
    run_command_sandboxed,
    read_file_command,
    write_file_command,
    edit_file_command,
    list_files_command,
    search_files_command,
    web_search_command,
    web_extract_command,
};

pub struct AuthFlowState {
    token: Arc<Mutex<Option<String>>>,
    status: Arc<Mutex<String>>,
    error: Arc<Mutex<Option<String>>>,
    expected_state: Arc<Mutex<Option<String>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopHttpHeader {
    name: String,
    value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopHttpResponse {
    status: u16,
    ok: bool,
    body: String,
}

impl Default for AuthFlowState {
    fn default() -> Self {
        Self {
            token: Arc::new(Mutex::new(None)),
            status: Arc::new(Mutex::new("idle".to_string())),
            error: Arc::new(Mutex::new(None)),
            expected_state: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPayload {
    app_name: String,
    app_version: String,
    platform: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthLaunchPayload {
    login_url: String,
    callback_url: String,
    device_id: String,
    auth_state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusPayload {
    status: String,
    error: Option<String>,
    has_token: bool,
}

fn normalize_base_url(base_url: Option<String>) -> String {
    let candidate = base_url
        .unwrap_or_else(|| "https://forge-app-peach.vercel.app".to_string())
        .trim()
        .to_string();

    let fallback = "https://forge-app-peach.vercel.app".to_string();
    if candidate.is_empty() {
        return fallback;
    }

    candidate.trim_end_matches('/').to_string()
}

fn write_callback_response(
    stream: &mut TcpStream,
    status_line: &str,
    title: &str,
    message: &str,
    close_window: bool,
) -> std::io::Result<()> {
    let close_script = if close_window {
        "<script>setTimeout(() => window.close(), 1200)</script>"
    } else {
        ""
    };

    let body = format!(
        "<html><body style=\"font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fdfdfc;color:#111;\"><div style=\"text-align:center;max-width:560px;padding:0 16px;\"><h2>{title}</h2><p>{message}</p></div>{close_script}</body></html>"
    );

    let content_length = body.as_bytes().len();
    let response = format!(
        "HTTP/1.1 {status_line}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {content_length}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}"
    );

    stream.write_all(response.as_bytes())
}

fn write_callback_success_response(stream: &mut TcpStream) -> std::io::Result<()> {
    write_callback_response(
        stream,
        "200 OK",
        "Authentication successful!",
        "You can close this window and return to Forge Desktop.",
        true,
    )
}

fn write_callback_pending_response(stream: &mut TcpStream) -> std::io::Result<()> {
    write_callback_response(
        stream,
        "202 Accepted",
        "Waiting for callback",
        "No authentication token was found in this request. Return to Forge Desktop and retry sign-in.",
        false,
    )
}

fn write_callback_error_response(stream: &mut TcpStream, message: &str) -> std::io::Result<()> {
    write_callback_response(stream, "400 Bad Request", "Authentication failed", message, false)
}

fn token_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    dir.push("session.token");
    Ok(dir)
}

fn desktop_http_request_sync(
    url: String,
    method: Option<String>,
    headers: Option<Vec<DesktopHttpHeader>>,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<DesktopHttpResponse, String> {
    let parsed_url = Url::parse(url.trim()).map_err(|e| format!("Invalid request URL: {e}"))?;
    let scheme = parsed_url.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("Only HTTP and HTTPS URLs are supported.".to_string());
    }

    let raw_method = method.unwrap_or_else(|| "GET".to_string());
    let normalized_method = raw_method.trim().to_uppercase();
    let request_method = reqwest::Method::from_bytes(normalized_method.as_bytes())
        .map_err(|_| format!("Unsupported HTTP method: {normalized_method}"))?;

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(20_000).clamp(1_000, 120_000));
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let mut request_builder = client.request(request_method, parsed_url);

    if let Some(header_list) = headers {
        for header in header_list {
            let name = header.name.trim();
            if name.is_empty() {
                continue;
            }

            request_builder = request_builder.header(name, header.value.trim());
        }
    }

    if let Some(raw_body) = body {
        request_builder = request_builder.body(raw_body);
    }

    let response = request_builder
        .send()
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status().as_u16();
    let ok = response.status().is_success();
    let body = response
        .text()
        .unwrap_or_else(|_| String::new());

    Ok(DesktopHttpResponse { status, ok, body })
}

#[tauri::command]
async fn desktop_http_request(
    url: String,
    method: Option<String>,
    headers: Option<Vec<DesktopHttpHeader>>,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<DesktopHttpResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        desktop_http_request_sync(url, method, headers, body, timeout_ms)
    })
    .await
    .map_err(|e| format!("HTTP worker join error: {e}"))?
}

#[tauri::command]
fn bootstrap() -> BootstrapPayload {
    BootstrapPayload {
        app_name: "Forge Desktop".to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}

#[tauri::command]
fn begin_auth_flow(
    state: State<AuthFlowState>,
    base_url: Option<String>,
    device_name: Option<String>,
) -> Result<AuthLaunchPayload, String> {
    {
        let status_guard = state
            .status
            .lock()
            .map_err(|e| format!("State lock error: {e}"))?;

        if status_guard.as_str() == "pending" {
            return Err("An auth flow is already in progress.".to_string());
        }
    }

    {
        let mut status_guard = state
            .status
            .lock()
            .map_err(|e| format!("State lock error: {e}"))?;
        *status_guard = "pending".to_string();
    }

    if let Ok(mut token_guard) = state.token.lock() {
        *token_guard = None;
    }
    if let Ok(mut error_guard) = state.error.lock() {
        *error_guard = None;
    }

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let callback_url = format!("http://127.0.0.1:{port}/callback");
    let auth_state = Uuid::new_v4().to_string();

    if let Ok(mut expected_state_guard) = state.expected_state.lock() {
        *expected_state_guard = Some(auth_state.clone());
    }

    let requested_name = device_name.unwrap_or_else(|| "Forge Desktop".to_string());
    let trimmed_name = requested_name.trim();
    let safe_device_name = if trimmed_name.is_empty() {
        "Forge Desktop".to_string()
    } else {
        trimmed_name.chars().take(120).collect()
    };

    let device_id = format!("desktop-{}", Uuid::new_v4());
    let os_name = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);
    let app_version = env!("CARGO_PKG_VERSION").to_string();
    let platform = std::env::consts::OS.to_string();

    let base = normalize_base_url(base_url);
    let mut login_url = Url::parse(&format!("{base}/desktop"))
        .map_err(|e| format!("Invalid Forge web base URL: {e}"))?;

    {
        let mut query = login_url.query_pairs_mut();
        query.append_pair("desktopLogin", "1");
        query.append_pair("cliLogin", "1");
        query.append_pair("callback", &callback_url);
        query.append_pair("cb", &callback_url);
        query.append_pair("deviceId", &device_id);
        query.append_pair("did", &device_id);
        query.append_pair("deviceName", &safe_device_name);
        query.append_pair("dn", &safe_device_name);
        query.append_pair("os", &os_name);
        query.append_pair("deviceType", "desktop_app");
        query.append_pair("appVersion", &app_version);
        query.append_pair("platform", &platform);
        query.append_pair("authState", &auth_state);
        query.append_pair("state", &auth_state);
    }

    let token_state = Arc::clone(&state.token);
    let status_state = Arc::clone(&state.status);
    let error_state = Arc::clone(&state.error);
    let expected_state_state = Arc::clone(&state.expected_state);
    let expected_state = auth_state.clone();

    thread::spawn(move || {
        let _ = listener.set_nonblocking(true);
        let started_at = Instant::now();
        let timeout = Duration::from_secs(300);
        let post_success_grace = Duration::from_secs(30);
        let mut success_observed_at: Option<Instant> = None;

        loop {
            if let Some(success_at) = success_observed_at {
                if success_at.elapsed() > post_success_grace {
                    break;
                }
            }

            if success_observed_at.is_none() && started_at.elapsed() > timeout {
                if let Ok(mut status_guard) = status_state.lock() {
                    *status_guard = "error".to_string();
                }
                if let Ok(mut error_guard) = error_state.lock() {
                    *error_guard = Some(
                        "Timed out waiting for desktop authentication callback.".to_string(),
                    );
                }
                if let Ok(mut expected_state_guard) = expected_state_state.lock() {
                    *expected_state_guard = None;
                }
                break;
            }

            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buffer = [0_u8; 8192];
                    let bytes_read = stream.read(&mut buffer).unwrap_or(0);
                    if bytes_read == 0 {
                        continue;
                    }

                    let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
                    let path = request
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1));

                    let Some(request_path) = path else {
                        if success_observed_at.is_some() {
                            let _ = write_callback_success_response(&mut stream);
                        } else {
                            let _ = write_callback_pending_response(&mut stream);
                        }
                        continue;
                    };

                    let parsed = Url::parse(&format!("http://localhost{request_path}"));
                    let Ok(url) = parsed else {
                        if success_observed_at.is_some() {
                            let _ = write_callback_success_response(&mut stream);
                        } else {
                            let _ = write_callback_pending_response(&mut stream);
                        }
                        continue;
                    };

                    let mut token: Option<String> = None;
                    let mut state_from_query: Option<String> = None;

                    for (key, value) in url.query_pairs() {
                        match key.as_ref() {
                            "token" => token = Some(value.to_string()),
                            "authState" | "state" => {
                                if state_from_query.is_none() {
                                    state_from_query = Some(value.to_string());
                                }
                            }
                            _ => {}
                        }
                    }

                    if let Some(received_token) = token {
                        let is_state_valid = match state_from_query {
                            Some(received_state) => received_state == expected_state,
                            None => true,
                        };

                        if !is_state_valid {
                            let _ = write_callback_error_response(
                                &mut stream,
                                "Invalid auth state. Start sign-in again from Forge Desktop.",
                            );
                            continue;
                        }

                        if let Ok(mut token_guard) = token_state.lock() {
                            if token_guard.is_none() {
                                *token_guard = Some(received_token);
                            }
                        }
                        if let Ok(mut status_guard) = status_state.lock() {
                            *status_guard = "success".to_string();
                        }
                        if let Ok(mut error_guard) = error_state.lock() {
                            *error_guard = None;
                        }
                        if let Ok(mut expected_state_guard) = expected_state_state.lock() {
                            *expected_state_guard = None;
                        }

                        let _ = write_callback_success_response(&mut stream);
                        success_observed_at = Some(Instant::now());
                        continue;
                    }

                    if success_observed_at.is_some() {
                        let _ = write_callback_success_response(&mut stream);
                    } else {
                        let _ = write_callback_pending_response(&mut stream);
                    }
                }
                Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(120));
                }
                Err(e) => {
                    if let Ok(mut status_guard) = status_state.lock() {
                        *status_guard = "error".to_string();
                    }
                    if let Ok(mut error_guard) = error_state.lock() {
                        *error_guard = Some(format!("Failed to accept callback: {e}"));
                    }
                    if let Ok(mut expected_state_guard) = expected_state_state.lock() {
                        *expected_state_guard = None;
                    }
                    break;
                }
            }
        }
    });

    Ok(AuthLaunchPayload {
        login_url: login_url.to_string(),
        callback_url,
        device_id,
        auth_state,
    })
}

#[tauri::command]
fn auth_status(state: State<AuthFlowState>) -> AuthStatusPayload {
    let status = state
        .status
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| "error".to_string());

    let error = state.error.lock().map(|value| value.clone()).unwrap_or(None);

    let has_token = state.token.lock().map(|value| value.is_some()).unwrap_or(false);

    AuthStatusPayload {
        status,
        error,
        has_token,
    }
}

#[tauri::command]
fn consume_auth_token(state: State<AuthFlowState>) -> Option<String> {
    let token = state.token.lock().ok()?.take();
    if token.is_some() {
        if let Ok(mut status_guard) = state.status.lock() {
            *status_guard = "idle".to_string();
        }
        if let Ok(mut error_guard) = state.error.lock() {
            *error_guard = None;
        }
        if let Ok(mut expected_state_guard) = state.expected_state.lock() {
            *expected_state_guard = None;
        }
    }
    token
}

#[tauri::command]
fn save_session_token(app: AppHandle, token: String) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("Token cannot be empty.".to_string());
    }

    let path = token_file_path(&app)?;
    std::fs::write(path, trimmed).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_session_token(app: AppHandle) -> Result<Option<String>, String> {
    let path = token_file_path(&app)?;

    match std::fs::read_to_string(path) {
        Ok(value) => {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn clear_session_token(app: AppHandle) -> Result<(), String> {
    let path = token_file_path(&app)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn should_skip_entry(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "dist" | "target" | ".next")
}

fn collect_workspace_entries(
    root: &Path,
    current: &Path,
    depth_limit: usize,
    current_depth: usize,
    out: &mut Vec<String>,
) -> Result<(), String> {
    if current_depth > depth_limit {
        return Ok(());
    }

    let entries = fs::read_dir(current).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();

        if should_skip_entry(&file_name) {
            continue;
        }

        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        if path.is_dir() {
            out.push(format!("{relative}/"));
            if current_depth < depth_limit {
                collect_workspace_entries(root, &path, depth_limit, current_depth + 1, out)?;
            }
        } else {
            out.push(relative);
        }

        if out.len() >= 500 {
            break;
        }
    }

    Ok(())
}

#[tauri::command]
fn list_workspace_files(base_path: Option<String>, depth: Option<u8>) -> Result<Vec<String>, String> {
    let resolved_root = if let Some(path) = base_path {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            std::env::current_dir().map_err(|e| e.to_string())?
        } else {
            let candidate = PathBuf::from(trimmed);
            if candidate.is_absolute() {
                candidate
            } else {
                std::env::current_dir()
                    .map_err(|e| e.to_string())?
                    .join(candidate)
            }
        }
    } else {
        std::env::current_dir().map_err(|e| e.to_string())?
    };

    if !resolved_root.exists() {
        return Err("Workspace path does not exist.".to_string());
    }

    if !resolved_root.is_dir() {
        return Err("Workspace path must be a directory.".to_string());
    }

    let depth_limit = depth.unwrap_or(3).clamp(1, 8) as usize;
    let mut entries = Vec::new();

    collect_workspace_entries(
        &resolved_root,
        &resolved_root,
        depth_limit,
        0,
        &mut entries,
    )?;

    entries.sort();
    if entries.len() > 1200 {
        entries.truncate(1200);
    }

    Ok(entries)
}

#[tauri::command]
fn read_workspace_file(path: String, max_bytes: Option<usize>) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path is required.".to_string());
    }

    let raw_path = PathBuf::from(trimmed);
    let resolved_path = if raw_path.is_absolute() {
        raw_path
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(raw_path)
    };

    if !resolved_path.exists() {
        return Err("File path does not exist.".to_string());
    }

    if resolved_path.is_dir() {
        return Err("Expected a file path but received a directory.".to_string());
    }

    let bytes = fs::read(&resolved_path).map_err(|e| e.to_string())?;
    let safe_limit = max_bytes.unwrap_or(50000).clamp(1024, 500000);
    let slice_end = bytes.len().min(safe_limit);
    let mut text = String::from_utf8_lossy(&bytes[..slice_end]).to_string();

    if bytes.len() > safe_limit {
        text.push_str("\n\n[...truncated...]");
    }

    Ok(text)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AuthFlowState::default())
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            desktop_http_request,
            begin_auth_flow,
            auth_status,
            consume_auth_token,
            save_session_token,
            load_session_token,
            clear_session_token,
            list_workspace_files,
            read_workspace_file,
            run_command,
            run_command_sandboxed,
            read_file_command,
            write_file_command,
            edit_file_command,
            list_files_command,
            search_files_command,
            web_search_command,
            web_extract_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running forge desktop")
}
