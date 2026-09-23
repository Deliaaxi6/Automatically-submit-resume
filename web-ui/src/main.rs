use axum::{
    Router,
    extract::{Json, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::Arc,
};
use tokio::{fs, process::Command, sync::RwLock};
use tower_http::services::ServeDir;
use tracing::{info, error};

const PYTHON_SCRIPT: &str = "main.py";
const NODE_AUTOMATION_DIR: &str = "node-automation";
const LOG_FILE: &str = "logs/deliver_log.json";

#[derive(Clone)]
struct AppState {
    python: String,
    node: String,
    script_dir: PathBuf,
    running: Arc<RwLock<HashMap<String, TaskStatus>>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct TaskStatus {
    task_id: String,
    status: String,
    message: String,
}

#[derive(Deserialize)]
struct SearchReq {
    keyword: String,
    city: String,
    max: u32,
    platforms: Vec<String>,
    sf: Option<u32>,
}

#[derive(Deserialize)]
struct UrlsReq {
    urls: String,
    platforms: Vec<String>,
}

#[derive(Deserialize)]
struct LoginReq {
    platform: String,
}

#[derive(Deserialize)]
struct ParseReq {
    file: String,
}

#[derive(Serialize)]
struct ApiResponse {
    ok: bool,
    message: String,
    data: Option<serde_json::Value>,
}

fn make_status(tid: &str, status: &str, message: String) -> (String, TaskStatus) {
    (
        tid.to_string(),
        TaskStatus {
            task_id: tid.to_string(),
            status: status.to_string(),
            message,
        },
    )
}

fn spawn_python_logged(
    python: &str,
    script_dir: &std::path::Path,
    args: Vec<String>,
    log_name: &str,
) -> anyhow::Result<tokio::process::Child> {
    let log_dir = script_dir.join("logs");
    std::fs::create_dir_all(&log_dir)?;

    let stdout_file = log_dir.join(format!("{log_name}_stdout.txt"));
    let stderr_file = log_dir.join(format!("{log_name}_stderr.txt"));

    let out = std::fs::File::create(&stdout_file)?;
    let err = std::fs::File::create(&stderr_file)?;

    Command::new(python)
        .args(args)
        .current_dir(script_dir)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(Into::into)
}

fn spawn_node_logged(
    node: &str,
    script_dir: &std::path::Path,
    args: Vec<String>,
    log_name: &str,
) -> anyhow::Result<tokio::process::Child> {
    let node_dir = script_dir.join(NODE_AUTOMATION_DIR);
    let log_dir = node_dir.join("logs");
    std::fs::create_dir_all(&log_dir)?;

    let stdout_file = log_dir.join(format!("{log_name}_stdout.txt"));
    let stderr_file = log_dir.join(format!("{log_name}_stderr.txt"));

    let out = std::fs::File::create(&stdout_file)?;
    let err = std::fs::File::create(&stderr_file)?;

    Command::new(node)
        .args(args)
        .current_dir(&node_dir)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(Into::into)
}

fn cookies_path_for(script_dir: &std::path::Path, platform: &str) -> PathBuf {
    script_dir.join("cookies").join(format!("{platform}_cookies.json"))
}

fn node_login_script(platform: &str) -> &'static str {
    match platform {
        "zhaopin" => "zhaopin-login.mjs",
        _ => "login.mjs",
    }
}

fn node_apply_script(platform: &str) -> &'static str {
    match platform {
        "zhaopin" => "zhaopin.mjs",
        _ => "boss.mjs",
    }
}

/// 生成 ISO-8601 UTC 时间戳（Chat 格式，避免引入 chrono 依赖）
fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    rfc3339_from_secs(secs)
}

/// 将 epoch 秒转换为 ISO-8601 UTC 时间戳（手动日期换算，避免引入 chrono 依赖）
fn rfc3339_from_secs(secs: u64) -> String {
    let days = secs / 86400;
    let secs_of_day = secs % 86400;
    let (h, m, s) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);

    let (mut y, mut month, mut day) = (1970i64, 1u32, 1u32);
    let mut remaining = days as i64;
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
        let yeardays = if leap { 366 } else { 365 };
        if remaining < yeardays { break; }
        remaining -= yeardays;
        y += 1;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
    let md = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (i, &d) in md.iter().enumerate() {
        if remaining < d { month = i as u32 + 1; day = remaining as u32 + 1; break; }
        remaining -= d;
    }
    format!("{y:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::rfc3339_from_secs;

    #[test]
    fn epoch_conversions() {
        // <epoch秒, 期望 ISO 字符串>（期望值来自 .NET DateTimeOffset.FromUnixTimeSeconds 验证）
        let cases: &[(u64, &str)] = &[
            (0, "1970-01-01T00:00:00Z"),
            (86399, "1970-01-01T23:59:59Z"),
            (86400, "1970-01-02T00:00:00Z"),
            (951782400, "2000-02-29T00:00:00Z"),   // 闰年 2 月 29
            (1136073600, "2006-01-01T00:00:00Z"),
            (1420070400, "2015-01-01T00:00:00Z"),
            (1451606400, "2016-01-01T00:00:00Z"),
            (1583020800, "2020-03-01T00:00:00Z"),  // 闰年跨月边界
            (1609459200, "2021-01-01T00:00:00Z"),
            (1640995200, "2022-01-01T00:00:00Z"),
            (1719763200, "2024-06-30T16:00:00Z"),
            (1746489600, "2025-05-06T00:00:00Z"),
            (1773292800, "2026-03-12T05:20:00Z"),
            (1800000000, "2027-01-15T08:00:00Z"),
            (1870000000, "2029-04-04T12:26:40Z"),
            (5364575999, "2139-12-30T23:59:59Z"),
        ];
        for (secs, expect) in cases {
            assert_eq!(rfc3339_from_secs(*secs), *expect, "sec={secs}");
        }
    }
}

/// 写入 deliver_log.json 的全局互斥锁，防止并发任务 read-modify-write 丢数据
static LOG_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();

/// 将 Node 搜索结果（details 中 status 非 preview 的条目）合并到 logs/deliver_log.json，
/// 供前端"投递记录"页读取。格式兼容旧 Python：{title, company, status, timestamp}
/// result_path 为本次任务专属的结果 json（避免并发任务互相覆盖）。
fn persist_deliver_logs(script_dir: &std::path::Path, platform: &str, keyword: &str, result_path: &std::path::Path) {
    use std::io::Write;

    let lock = LOG_LOCK.get_or_init(|| std::sync::Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    let Ok(content) = std::fs::read_to_string(result_path) else { return };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else { return };
    let Some(details) = value.get("details").and_then(|d| d.as_array()) else { return };

    let log_path = script_dir.join(LOG_FILE);
    let mut logs: serde_json::Value = if log_path.exists() {
        std::fs::read_to_string(&log_path)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or_else(|| serde_json::json!([]))
    } else {
        serde_json::json!([])
    };
    let Some(arr) = logs.as_array_mut() else { return };

    for d in details {
        let status = d.get("status").and_then(|s| s.as_str()).unwrap_or("");
        // 只记录真实投递结果，跳过 preview（预览未真实投递）
        if status == "preview" {
            continue;
        }
        let title = d.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
        let company = d.get("company").and_then(|t| t.as_str()).unwrap_or("").to_string();
        // 去重：同平台下 (title, company) 已入库则跳过，防止异常退出/重复运行导致重复写入
        let is_dup = arr.iter().any(|e| {
            e.get("platform").and_then(|p| p.as_str()) == Some(platform)
                && e.get("title").and_then(|t| t.as_str()) == Some(title.as_str())
                && e.get("company").and_then(|c| c.as_str()) == Some(company.as_str())
        });
        if is_dup {
            continue;
        }
        let mut rec = serde_json::Map::new();
        rec.insert("title".into(), serde_json::json!(title));
        rec.insert("company".into(), serde_json::json!(company));
        rec.insert("platform".into(), serde_json::json!(platform));
        rec.insert("status".into(), serde_json::json!(status.to_string()));
        rec.insert("keyword".into(), serde_json::json!(keyword));
        rec.insert("timestamp".into(), serde_json::json!(now_rfc3339()));
        arr.push(serde_json::Value::Object(rec));
    }

    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::File::create(&log_path) {
        let _ = f.write_all(serde_json::to_string_pretty(&arr).unwrap_or_default().as_bytes());
    }
}

fn python_bin() -> String {
    let candidates = [
        r"D:\develop\Miniconda3\python.exe",
        r"D:\develop\Anaconda3\python.exe",
        r"C:\ProgramData\miniconda3\python.exe",
        r"C:\ProgramData\Anaconda3\python.exe",
        r"C:\Users\Delia\miniconda3\python.exe",
        r"C:\Users\Delia\anaconda3\python.exe",
    ];
    for c in candidates {
        if std::path::Path::new(c).exists() {
            return c.to_string();
        }
    }
    if cfg!(target_os = "windows") { "python".to_string() } else { "python3".to_string() }
}

fn node_bin() -> String {
    let is_windows = cfg!(target_os = "windows");
    let node_exe = if is_windows { "node.exe".to_string() } else { "bin/node".to_string() };
    let mut candidates: Vec<String> = if is_windows {
        vec![
            r"D:\develop\nodejs\node.exe".to_string(),
            r"C:\Program Files\nodejs\node.exe".to_string(),
            r"C:\Program Files (x86)\nodejs\node.exe".to_string(),
        ]
    } else {
        vec![
            "/opt/homebrew/bin/node".to_string(),
            "/usr/local/bin/node".to_string(),
            "/usr/bin/node".to_string(),
        ]
    };
    // 便携模式：exe 同目录内的 node 运行时可执行文件优先（win: node.exe，mac: bin/node）
    if let Some(d) = std::env::current_exe().ok().and_then(|p| p.parent().map(|dir| dir.to_path_buf())) {
        candidates.insert(0, d.join(&node_exe).to_string_lossy().to_string());
    }
    for c in candidates {
        if std::path::Path::new(&c).exists() {
            return c;
        }
    }
    "node".to_string()
}

async fn task_outcome(tid: &str, child_result: anyhow::Result<tokio::process::Child>, ok_msg: String, fail_msg: String) -> (String, TaskStatus) {
    match child_result {
        Ok(mut child) => match child.wait().await {
            Ok(status_code) if status_code.success() => {
                make_status(tid, "done", ok_msg)
            }
            Ok(_) => make_status(tid, "error", fail_msg),
            Err(e) => make_status(tid, "error", format!("等待进程失败: {}", e)),
        },
        Err(e) => {
            error!("启动脚本失败: {}", e);
            make_status(tid, "error", format!("启动失败: {}", e))
        }
    }
}

async fn api_login(State(state): State<AppState>, Json(req): Json<LoginReq>) -> impl IntoResponse {
    let task_id = uuid::Uuid::new_v4().to_string();
    let platform = req.platform.clone();

    let status = TaskStatus {
        task_id: task_id.clone(),
        status: "running".into(),
        message: format!("正在打开浏览器登录 {}...", platform),
    };
    state.running.write().await.insert(task_id.clone(), status);

    let script_dir = state.script_dir.clone();
    let node = state.node.clone();
    let running = state.running.clone();
    let tid = task_id.clone();
    let platform_inner = platform.clone();

    tokio::spawn(async move {
        let script = node_login_script(&platform_inner);
        let cookies = cookies_path_for(&script_dir, &platform_inner);
        let args = vec![script.to_string(), "--cookies".into(), cookies.to_string_lossy().to_string()];
        let result = spawn_node_logged(&node, &script_dir, args, &format!("login_{platform_inner}"));
        let (k, v) = task_outcome(
            &tid,
            result,
            format!("{} 登录完成，Cookie 已保存", platform_inner),
            format!("{} 登录失败或超时", platform_inner),
        ).await;
        running.write().await.insert(k, v);
    });

    Json(ApiResponse {
        ok: true,
        message: "登录任务已启动，请在弹出的浏览器中完成登录".into(),
        data: Some(serde_json::json!({"task_id": task_id})),
    })
}

async fn api_search(State(state): State<AppState>, Json(req): Json<SearchReq>) -> impl IntoResponse {
    let task_id = uuid::Uuid::new_v4().to_string();
    let platforms = req.platforms.join(" ");

    let status = TaskStatus {
        task_id: task_id.clone(),
        status: "running".into(),
        message: format!("搜索投递: {} @ {}", req.keyword, req.city),
    };
    state.running.write().await.insert(task_id.clone(), status);

    let script_dir = state.script_dir.clone();
    let node = state.node.clone();
    let running = state.running.clone();
    let tid = task_id.clone();

    let platforms_vec: Vec<String> = platforms.split_whitespace().map(|s| s.to_string()).collect();
    let kw = req.keyword.clone();
    let city = req.city.clone();
    let max = req.max;
    let sf = req.sf;

    tokio::spawn(async move {
        let mut overall = String::new();
        for platform in &platforms_vec {
            let script = node_apply_script(platform);
            let cookies = cookies_path_for(&script_dir, platform);
            // 每次任务用唯一 out 文件，避免并发任务互相覆盖同一 search_{platform}.json
            let short = tid.replace('-', "");
            let out_path = script_dir
                .join("logs")
                .join(format!("search_{platform}_{}.json", &short[..8.min(short.len())]))
                .to_string_lossy()
                .to_string();
            let mut args = vec![
                script.to_string(),
                "--mode".into(), "search".into(),
                "--keyword".into(), kw.clone(),
                "--city".into(), city.clone(),
                "--max".into(), max.to_string(),
                "--cookies".into(), cookies.to_string_lossy().to_string(),
                "--out".into(), out_path.clone(),
            ];
            if let Some(s) = sf {
                args.push("--sf".into());
                args.push(s.to_string());
            }
            let log_name = format!("search_{platform}");
            let result = spawn_node_logged(&node, &script_dir, args, &log_name);
            match task_outcome(&tid, result, format!("{} 搜索投递完成", platform), format!("{} 搜索投递失败", platform)).await {
                (_, v) => overall.push_str(&format!("[{}] {} ", platform, v.status)),
            }
            // 把 Node 搜索结果合并进 deliver_log.json，供前端"投递记录"页展示
            persist_deliver_logs(&script_dir, platform, &kw, &std::path::PathBuf::from(out_path));
        }
        running.write().await.insert(tid.clone(), make_status(&tid, "done", overall.trim().to_string()).1);
    });

    Json(ApiResponse {
        ok: true,
        message: "搜索投递任务已启动".into(),
        data: Some(serde_json::json!({"task_id": task_id})),
    })
}

async fn api_urls(State(state): State<AppState>, Json(req): Json<UrlsReq>) -> (StatusCode, Json<ApiResponse>) {
    let task_id = uuid::Uuid::new_v4().to_string();

    let urls_file_full = state.script_dir.join("urls_input.txt");
    if let Err(e) = fs::write(&urls_file_full, &req.urls).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse { ok: false, message: format!("写入 URL 文件失败: {}", e), data: None }),
        );
    }

    let platforms = req.platforms.join(" ");

    let status = TaskStatus {
        task_id: task_id.clone(),
        status: "running".into(),
        message: "按链接投递中...".into(),
    };
    state.running.write().await.insert(task_id.clone(), status);

    let script_dir = state.script_dir.clone();
    let python = state.python.clone();
    let running = state.running.clone();
    let tid = task_id.clone();

    tokio::spawn(async move {
        let mut args = vec![
            "main.py".to_string(),
            "urls".into(),
            "urls_input.txt".into(),
        ];
        if !platforms.is_empty() {
            args.push("-p".into());
            args.extend(platforms.split_whitespace().map(|s| s.to_string()));
        }

        let result = spawn_python_logged(&python, &script_dir, args, "urls");
        let (k, v) = task_outcome(&tid, result, "链接投递完成".into(), "链接投递失败，请查看日志".into()).await;
        running.write().await.insert(k, v);
    });

    (
        StatusCode::OK,
        Json(ApiResponse {
            ok: true,
            message: "链接投递任务已启动".into(),
            data: Some(serde_json::json!({"task_id": task_id})),
        }),
    )
}

async fn api_parse(State(state): State<AppState>, Json(req): Json<ParseReq>) -> impl IntoResponse {
    let script = state.script_dir.join(PYTHON_SCRIPT);
    let output = Command::new(&state.python)
        .arg(script.to_str().unwrap())
        .arg("parse")
        .arg("-r")
        .arg(&req.file)
        .current_dir(&state.script_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;

    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout).to_string();
            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
            let lines: Vec<&str> = stdout.lines().collect();

            let mut data = serde_json::json!({"raw": stdout});
            for line in &lines {
                if let Some((k, v)) = line.split_once(':') {
                    let key = k.trim().to_string();
                    let val = v.trim().to_string();
                    if !val.is_empty() && val != "未识别" {
                        data[key] = serde_json::json!(val);
                    }
                }
            }

            Json(ApiResponse {
                ok: o.status.success(),
                message: if o.status.success() { "解析完成".into() } else { stderr },
                data: Some(data),
            })
        }
        Err(e) => Json(ApiResponse {
            ok: false,
            message: format!("启动失败: {}", e),
            data: None,
        }),
    }
}

async fn api_logs(State(state): State<AppState>) -> impl IntoResponse {
    let log_path = state.script_dir.join(LOG_FILE);
    if !log_path.exists() {
        return Json(serde_json::json!([]));
    }
    match fs::read_to_string(&log_path).await {
        Ok(content) => {
            let data: serde_json::Value = serde_json::from_str(&content).unwrap_or(serde_json::json!([]));
            Json(data)
        }
        Err(e) => {
            error!("读取投递日志失败: {}", e);
            Json(serde_json::json!([]))
        }
    }
}

async fn api_task_status(
    State(state): State<AppState>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let running = state.running.read().await;
    match running.get(&task_id) {
        Some(status) => Json(serde_json::json!(status)),
        None => Json(serde_json::json!({"status": "unknown", "message": "任务不存在"})),
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .init();

    let dev_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    // 便携模式：exe 与 node-automation/ 同目录（绿色包）。开发模式回退到现有项目根。
    let script_dir = exe_dir.as_ref().filter(|d| d.join(NODE_AUTOMATION_DIR).is_dir())
        .cloned()
        .unwrap_or_else(|| dev_root.clone());
    let python = python_bin();
    let node = node_bin();

    let state = AppState {
        python,
        node,
        script_dir,
        running: Arc::new(RwLock::new(HashMap::new())),
    };

    // 静态资源目录：优先 exe 旁 static/（便携包），回退 web-ui/static（开发）
    let static_dir = exe_dir.as_ref().map(|d| d.join("static")).filter(|s| s.is_dir())
        .unwrap_or_else(|| dev_root.join("web-ui").join("static"));

    let app = Router::new()
        .route("/api/login", post(api_login))
        .route("/api/search", post(api_search))
        .route("/api/urls", post(api_urls))
        .route("/api/parse", post(api_parse))
        .route("/api/logs", get(api_logs))
        .route("/api/task/{task_id}", get(api_task_status))
        .fallback_service(ServeDir::new(&static_dir))
        .with_state(state);

    let addr = "127.0.0.1:3456";
    info!("简历投递工具已启动: http://{}", addr);
    println!("\n  简历自动投递工具 Web UI");
    println!("  访问: http://{}\n", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
