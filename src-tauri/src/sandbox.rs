// src-tauri/src/sandbox.rs
// Sandboxed command execution and file operations for Forge Agent

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::command;

// ── Shared Types ─────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub ok: bool,
    pub output: String,
    pub error: String,
    pub code: i32,
}

// ── Path Safety ──────────────────────────────────────────────────────

fn validate_path(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    // Canonicalize if exists, otherwise validate parent
    if p.exists() {
        p.canonicalize().map_err(|e| format!("Cannot resolve path: {e}"))
    } else {
        // For new files, validate the parent directory
        if let Some(parent) = p.parent() {
            if parent.exists() {
                parent.canonicalize().map(|mut pb| {
                    pb.push(p.file_name().unwrap_or_default());
                    pb
                }).map_err(|e| format!("Cannot resolve parent path: {e}"))
            } else {
                Err("Parent directory does not exist".to_string())
            }
        } else {
            Err("Invalid path".to_string())
        }
    }
}

// ── Read File ────────────────────────────────────────────────────────

#[command]
pub fn read_file_command(
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> CommandResult {
    let start_line = offset.unwrap_or(1).max(1);
    let max_lines = limit.unwrap_or(200).min(5000);

    match validate_path(&path) {
        Ok(resolved) => match std::fs::read_to_string(&resolved) {
            Ok(content) => {
                let lines: Vec<&str> = content.lines().collect();
                let total = lines.len();
                let start = (start_line - 1).min(total);
                let end = (start + max_lines).min(total);

                let mut output = String::new();
                for (i, line) in lines[start..end].iter().enumerate() {
                    output.push_str(&format!("{:4}|{}\n", start + i + 1, line));
                }

                if end < total {
                    output.push_str(&format!("\n[... {} more lines ...]\n", total - end));
                }

                CommandResult {
                    ok: true,
                    output,
                    error: String::new(),
                    code: 0,
                }
            }
            Err(e) => CommandResult {
                ok: false,
                output: String::new(),
                error: format!("Cannot read file: {e}"),
                code: 1,
            },
        },
        Err(e) => CommandResult {
            ok: false,
            output: String::new(),
            error: e,
            code: 1,
        },
    }
}

// ── Write File ───────────────────────────────────────────────────────

#[command]
pub fn write_file_command(path: String, content: String) -> CommandResult {
    let p = Path::new(&path);

    // Create parent directories
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return CommandResult {
                    ok: false,
                    output: String::new(),
                    error: format!("Cannot create directory: {e}"),
                    code: 1,
                };
            }
        }
    }

    match std::fs::write(p, &content) {
        Ok(_) => CommandResult {
            ok: true,
            output: format!("Written {} bytes to {}", content.len(), path),
            error: String::new(),
            code: 0,
        },
        Err(e) => CommandResult {
            ok: false,
            output: String::new(),
            error: format!("Cannot write file: {e}"),
            code: 1,
        },
    }
}

// ── Edit File (find & replace) ───────────────────────────────────────

#[command]
pub fn edit_file_command(
    path: String,
    old_text: String,
    new_text: String,
) -> CommandResult {
    let p = Path::new(&path);

    match std::fs::read_to_string(p) {
        Ok(content) => {
            let occurrences = content.matches(&old_text).count();
            if occurrences == 0 {
                return CommandResult {
                    ok: false,
                    output: String::new(),
                    error: "Search text not found in file".to_string(),
                    code: 1,
                };
            }
            if occurrences > 1 {
                return CommandResult {
                    ok: false,
                    output: String::new(),
                    error: format!(
                        "Search text found {} times — must be unique for safe editing. Use write_file for bulk replacements.",
                        occurrences
                    ),
                    code: 1,
                };
            }

            let new_content = content.replace(&old_text, &new_text);
            match std::fs::write(p, &new_content) {
                Ok(_) => {
                    let old_lines = old_text.lines().count();
                    let new_lines = new_text.lines().count();
                    CommandResult {
                        ok: true,
                        output: format!(
                            "Replaced {} line(s) with {} line(s) in {}",
                            old_lines, new_lines, path
                        ),
                        error: String::new(),
                        code: 0,
                    }
                }
                Err(e) => CommandResult {
                    ok: false,
                    output: String::new(),
                    error: format!("Cannot write edited file: {e}"),
                    code: 1,
                },
            }
        }
        Err(e) => CommandResult {
            ok: false,
            output: String::new(),
            error: format!("Cannot read file: {e}"),
            code: 1,
        },
    }
}

// ── List Files ───────────────────────────────────────────────────────

#[command]
pub fn list_files_command(
    path: String,
    pattern: Option<String>,
    max_depth: Option<usize>,
    limit: Option<usize>,
) -> CommandResult {
    let base = Path::new(&path);
    let depth = max_depth.unwrap_or(3).min(10);
    let max_items = limit.unwrap_or(100).min(1000);

    if !base.exists() {
        return CommandResult {
            ok: false,
            output: String::new(),
            error: "Directory does not exist".to_string(),
            code: 1,
        };
    }

    let glob_pattern = pattern.unwrap_or_else(|| "*".to_string());
    let mut results: Vec<String> = Vec::new();

    fn walk_dir(
        dir: &Path,
        base: &Path,
        current_depth: usize,
        max_depth: usize,
        glob: &str,
        results: &mut Vec<String>,
        max_items: usize,
    ) {
        if current_depth > max_depth || results.len() >= max_items {
            return;
        }

        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            if results.len() >= max_items {
                break;
            }

            let path = entry.path();
            let file_name = path.file_name()
                .unwrap_or_default()
                .to_string_lossy();

            // Simple glob matching
            let matches = if glob == "*" || glob == "**/*" {
                true
            } else if glob.starts_with("*.") {
                let ext = &glob[1..];
                file_name.ends_with(ext)
            } else {
                file_name.contains(glob)
            };

            if matches {
                let rel = path.strip_prefix(base).unwrap_or(&path);
                let is_dir = path.is_dir();
                let suffix = if is_dir { "/" } else { "" };
                results.push(format!("{}{}", rel.display(), suffix));
            }

            if path.is_dir() && current_depth < max_depth {
                walk_dir(&path, base, current_depth + 1, max_depth, glob, results, max_items);
            }
        }
    }

    walk_dir(base, base, 0, depth, &glob_pattern, &mut results, max_items);

    CommandResult {
        ok: true,
        output: results.join("\n"),
        error: String::new(),
        code: 0,
    }
}

// ── Search Files ─────────────────────────────────────────────────────

#[command]
pub fn search_files_command(
    path: String,
    pattern: String,
    file_glob: Option<String>,
    max_results: Option<usize>,
) -> CommandResult {
    let base = Path::new(&path);
    let max = max_results.unwrap_or(50).min(500);

    if !base.exists() {
        return CommandResult {
            ok: false,
            output: String::new(),
            error: "Search directory does not exist".to_string(),
            code: 1,
        };
    }

    let regex = match regex::Regex::new(&pattern) {
        Ok(r) => r,
        Err(e) => {
            return CommandResult {
                ok: false,
                output: String::new(),
                error: format!("Invalid regex: {e}"),
                code: 1,
            }
        }
    };

    let mut results: Vec<String> = Vec::new();

    fn search_dir(
        dir: &Path,
        regex: &regex::Regex,
        file_glob: &Option<String>,
        results: &mut Vec<String>,
        max: usize,
    ) {
        if results.len() >= max {
            return;
        }

        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            if results.len() >= max {
                break;
            }

            let path = entry.path();

            if path.is_dir() {
                // Skip common non-source dirs
                let dir_name = path.file_name().unwrap_or_default().to_string_lossy();
                if !matches!(dir_name.as_ref(), "node_modules" | ".git" | "target" | "dist" | "build" | ".next" | "__pycache__") {
                    search_dir(&path, regex, file_glob, results, max);
                }
                continue;
            }

            // Check file glob filter
            if let Some(ref glob) = file_glob {
                let file_name = path.file_name().unwrap_or_default().to_string_lossy();
                if glob.starts_with("*.") {
                    let ext = &glob[1..];
                    if !file_name.ends_with(ext) {
                        continue;
                    }
                }
            }

            // Skip binary-like files by extension
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if matches!(
                    ext.to_lowercase().as_str(),
                    "png" | "jpg" | "jpeg" | "gif" | "ico" | "svg" | "woff" | "woff2"
                    | "ttf" | "eot" | "mp3" | "mp4" | "avi" | "pdf" | "zip" | "tar" | "gz"
                    | "exe" | "dll" | "so" | "dylib" | "bin" | "wasm"
                ) {
                    continue;
                }
            }

            // Read and search file
            if let Ok(content) = std::fs::read_to_string(&path) {
                let rel = path.to_string_lossy();
                for (i, line) in content.lines().enumerate() {
                    if results.len() >= max {
                        break;
                    }
                    if regex.is_match(line) {
                        results.push(format!(
                            "{}:{}: {}",
                            rel,
                            i + 1,
                            line.trim()
                        ));
                    }
                }
            }
        }
    }

    search_dir(base, &regex, &file_glob, &mut results, max);

    CommandResult {
        ok: true,
        output: if results.is_empty() {
            "No matches found.".to_string()
        } else {
            format!("Found {} match(es):\n{}", results.len(), results.join("\n"))
        },
        error: String::new(),
        code: 0,
    }
}

// ── Sandboxed Terminal ───────────────────────────────────────────────

#[command]
pub fn run_command_sandboxed(
    command: String,
    cwd: Option<String>,
    timeout: Option<u64>,
) -> CommandResult {
    let timeout_ms = timeout.unwrap_or(30_000).min(120_000);
    let timeout_dur = Duration::from_millis(timeout_ms);

    // Block dangerous commands
    let blocked = [
        "rm -rf /", "mkfs", "dd if=", ":(){ :|:& };:",
        "chmod 777", "chown root", "sudo rm",
    ];
    let cmd_lower = command.to_lowercase();
    for blocked_cmd in &blocked {
        if cmd_lower.contains(blocked_cmd) {
            return CommandResult {
                ok: false,
                output: String::new(),
                error: format!("Blocked dangerous command pattern: {}", blocked_cmd),
                code: 126,
            };
        }
    }

    let working_dir = cwd.unwrap_or_else(|| ".".to_string());
    let work_path = Path::new(&working_dir);

    let started = Instant::now();
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_clone = cancelled.clone();

    // Spawn process
    let child = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(work_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            return CommandResult {
                ok: false,
                output: String::new(),
                error: format!("Cannot spawn command: {e}"),
                code: 127,
            }
        }
    };

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let stdout_buf = Arc::new(Mutex::new(Vec::new()));
    let stderr_buf = Arc::new(Mutex::new(Vec::new()));

    let stdout_buf_clone = stdout_buf.clone();
    let stderr_buf_clone = stderr_buf.clone();

    // Read stdout in a thread
    let stdout_handle = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut lock) = stdout_buf_clone.lock() {
                        lock.extend_from_slice(&buf[..n]);
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Read stderr in a thread
    let stderr_handle = thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut lock) = stderr_buf_clone.lock() {
                        lock.extend_from_slice(&buf[..n]);
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Wait with timeout
    let exit_code;
    loop {
        if cancelled_clone.load(Ordering::Relaxed) {
            let _ = child.kill();
            return CommandResult {
                ok: false,
                output: String::new(),
                error: "Command cancelled".to_string(),
                code: -1,
            };
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code().unwrap_or(-1);
                break;
            }
            Ok(None) => {
                if started.elapsed() > timeout_dur {
                    let _ = child.kill();
                    let _ = child.wait();
                    return CommandResult {
                        ok: false,
                        output: String::new(),
                        error: format!("Command timed out after {}ms", timeout_ms),
                        code: -1,
                    };
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                return CommandResult {
                    ok: false,
                    output: String::new(),
                    error: format!("Command wait error: {e}"),
                    code: -1,
                };
            }
        }
    }

    let _ = stdout_handle.join();
    let _ = stderr_handle.join();

    let stdout_str = stdout_buf
        .lock()
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_default();
    let stderr_str = stderr_buf
        .lock()
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_default();

    // Cap output size
    let max_output = 50_000;
    let stdout_trimmed = if stdout_str.len() > max_output {
        format!("{}...[truncated]", &stdout_str[..max_output])
    } else {
        stdout_str
    };
    let stderr_trimmed = if stderr_str.len() > max_output {
        format!("{}...[truncated]", &stderr_str[..max_output])
    } else {
        stderr_str
    };

    let mut combined = stdout_trimmed;
    if !stderr_trimmed.is_empty() {
        if !combined.is_empty() {
            combined.push_str("\n--- stderr ---\n");
        }
        combined.push_str(&stderr_trimmed);
    }

    CommandResult {
        ok: exit_code == 0,
        output: combined.clone(),
        error: if exit_code != 0 { combined } else { String::new() },
        code: exit_code,
    }
}

// ── Web Search ───────────────────────────────────────────────────────

#[command]
pub async fn web_search_command(
    query: String,
    limit: Option<usize>,
) -> CommandResult {
    let max_results = limit.unwrap_or(5).min(10);

    // Use Tavily API if available, otherwise return a helpful message
    let tavily_key = std::env::var("TAVILY_API_KEY").unwrap_or_default();
    if tavily_key.is_empty() {
        return CommandResult {
            ok: false,
            output: String::new(),
            error: "Web search requires TAVILY_API_KEY environment variable. Set it in ~/.hermes/.env".to_string(),
            code: 1,
        };
    }

    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "api_key": tavily_key,
        "query": query,
        "max_results": max_results,
        "include_answer": true,
    });

    match client
        .post("https://api.tavily.com/search")
        .json(&body)
        .send()
        .await
    {
        Ok(response) => match response.json::<serde_json::Value>().await {
            Ok(data) => {
                let mut results = Vec::new();

                if let Some(answer) = data.get("answer").and_then(|a| a.as_str()) {
                    results.push(format!("## Answer\n{}\n", answer));
                }

                if let Some(items) = data.get("results").and_then(|r| r.as_array()) {
                    results.push("## Search Results\n".to_string());
                    for (i, item) in items.iter().enumerate() {
                        let title = item.get("title").and_then(|t| t.as_str()).unwrap_or("");
                        let url = item.get("url").and_then(|u| u.as_str()).unwrap_or("");
                        let snippet = item.get("content").and_then(|s| s.as_str()).unwrap_or("");
                        results.push(format!(
                            "{}. **{}**\n   {}\n   {}\n",
                            i + 1,
                            title,
                            url,
                            snippet
                        ));
                    }
                }

                CommandResult {
                    ok: true,
                    output: results.join("\n"),
                    error: String::new(),
                    code: 0,
                }
            }
            Err(e) => CommandResult {
                ok: false,
                output: String::new(),
                error: format!("Failed to parse search response: {e}"),
                code: 1,
            },
        },
        Err(e) => CommandResult {
            ok: false,
            output: String::new(),
            error: format!("Search request failed: {e}"),
            code: 1,
        },
    }
}

// ── Web Extract ──────────────────────────────────────────────────────

#[command]
pub async fn web_extract_command(url: String) -> CommandResult {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("ForgeDesktop/1.0")
        .build();

    let client = match client {
        Ok(c) => c,
        Err(e) => {
            return CommandResult {
                ok: false,
                output: String::new(),
                error: format!("Cannot create HTTP client: {e}"),
                code: 1,
            }
        }
    };

    match client.get(&url).send().await {
        Ok(response) => {
            let status = response.status();
            if !status.is_success() {
                return CommandResult {
                    ok: false,
                    output: String::new(),
                    error: format!("HTTP {status} fetching {url}"),
                    code: 1,
                };
            }

            match response.text().await {
                Ok(html) => {
                    // Basic HTML to text conversion — strip tags
                    let re_tags = regex::Regex::new(r"<[^>]+>").unwrap();
                    let re_scripts = regex::Regex::new(r"(?is)<script[^>]*>.*?</script>").unwrap();
                    let re_styles = regex::Regex::new(r"(?is)<style[^>]*>.*?</style>").unwrap();
                    let re_whitespace = regex::Regex::new(r"\n\s*\n").unwrap();

                    let text = re_scripts.replace_all(&html, "");
                    let text = re_styles.replace_all(&text, "");
                    let text = re_tags.replace_all(&text, " ");
                    let text = html_escape::decode_html_entities(&text);
                    let text = re_whitespace.replace_all(&text.trim(), "\n\n");

                    // Cap at 15K chars
                    let trimmed = if text.len() > 15000 {
                        format!("{}...\n\n[Content truncated at 15K chars]", &text[..15000])
                    } else {
                        text.to_string()
                    };

                    CommandResult {
                        ok: true,
                        output: trimmed,
                        error: String::new(),
                        code: 0,
                    }
                }
                Err(e) => CommandResult {
                    ok: false,
                    output: String::new(),
                    error: format!("Failed to read response: {e}"),
                    code: 1,
                },
            }
        }
        Err(e) => CommandResult {
            ok: false,
            output: String::new(),
            error: format!("Failed to fetch {url}: {e}"),
            code: 1,
        },
    }
}
