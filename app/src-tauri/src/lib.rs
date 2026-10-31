use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::Manager;

mod kernel;

/// 正在跑的模型流：stream_id → 中断旗标。
/// 前端点「停止」时立旗，读流的循环下一块就撒手——不然一轮对话跑飞了只能等它说完。
static LLM_STREAMS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn llm_streams() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    LLM_STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
fn llm_abort(stream_id: Option<String>) -> Result<(), String> {
    let map = llm_streams().lock().map_err(|e| e.to_string())?;
    match stream_id {
        Some(id) => {
            if let Some(flag) = map.get(&id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
        // 没给 id：掐掉所有在跑的流（界面上同时只可能有一条）
        None => {
            for flag in map.values() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
    Ok(())
}

fn default_config() -> Value {
    json!({
        "configVersion": 3,
        "projectRoot": "",
        "comfyDir": "engine/ComfyUI",
        "comfyBase": "engine/workspace",
        "venvPython": "engine/venv/Scripts/python.exe",
        "comfyPort": 8188,
        "llm": {
            "baseUrl": "https://api.deepseek.com/v1",
            "apiKey": "",
            "model": "deepseek-flash"
        },
        "ark": { "apiKey": "" },
        "image": {
            "model": "doubao-seedream-5-0-pro-260628",
            "size": "1080x1920"
        },
        "video": {
            "model": "doubao-seedance-2-5-260628",
            "resolution": "720p",
            "generateAudio": true
        },
        "budget": {
            "maxShots": 3,
            "maxSeconds": 30
        }
    })
}

fn merge(base: Value, over: Value) -> Value {
    match (base, over) {
        (Value::Object(mut b), Value::Object(o)) => {
            for (k, v) in o {
                let next = match b.remove(&k) {
                    Some(old) => merge(old, v),
                    None => v,
                };
                b.insert(k, next);
            }
            Value::Object(b)
        }
        (_, o) => o,
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位配置目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

fn load_config(app: &tauri::AppHandle) -> Value {
    let fallback = default_config();
    let Ok(path) = config_path(app) else {
        return fallback;
    };
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(mut v) = serde_json::from_str::<Value>(&text) {
            let version = v
                .get("configVersion")
                .and_then(|x| x.as_u64())
                .unwrap_or(0);
            let mut migrated = false;

            // v1 把项目根和内核路径写死在配置文件里，升级后一律换成相对路径
            if version < 2 {
                if let Some(obj) = v.as_object_mut() {
                    for key in ["projectRoot", "comfyDir", "comfyBase", "venvPython"] {
                        obj.remove(key);
                    }
                }
                migrated = true;
            }

            // v3 拆分两个 Key：llm 走对话模型，ark 走生图/生视频节点
            if version < 3 {
                if let Some(obj) = v.as_object_mut() {
                    let legacy_key = obj
                        .get("llm")
                        .and_then(|l| l.get("apiKey"))
                        .and_then(|k| k.as_str())
                        .map(str::trim)
                        .unwrap_or("")
                        .to_string();
                    let ark = obj.entry("ark").or_insert_with(|| json!({}));
                    if !ark.is_object() {
                        *ark = json!({});
                    }
                    if let Some(ark_obj) = ark.as_object_mut() {
                        let current = ark_obj
                            .get("apiKey")
                            .and_then(|k| k.as_str())
                            .map(str::trim)
                            .unwrap_or("");
                        // 老配置把 ARK Key 填在 llm.apiKey 里的，迁移到 ark.apiKey
                        if current.is_empty() && legacy_key.starts_with("ark-") {
                            ark_obj.insert("apiKey".into(), json!(legacy_key));
                        }
                    }
                    obj.insert("configVersion".into(), json!(3));
                }
                migrated = true;
            }

            let merged = merge(fallback, v);
            if migrated {
                let _ = std::fs::write(&path, serde_json::to_string_pretty(&merged).unwrap_or_default());
            }
            return merged;
        }
    }
    let _ = std::fs::write(
        &path,
        serde_json::to_string_pretty(&fallback).unwrap_or_default(),
    );
    fallback
}

/// 产品根标记：engine/ 下有 workspace 或 prompts 任一即认定（换内核后不再有 ComfyUI）
fn is_product_root(path: &Path) -> bool {
    let engine = path.join("engine");
    engine.join("workspace").is_dir() || engine.join("prompts").is_dir()
}

fn walk_to_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .map(PathBuf::from)
        .find(|p| is_product_root(p))
}

/// 产品根目录：优先环境变量 / 配置，其次从 exe 与当前目录向上找。
/// 不再依赖任何写死的绝对路径。
fn detect_root(cfg: &Value) -> PathBuf {
    if let Ok(env_root) = std::env::var("STORYFORGE_ROOT") {
        let p = PathBuf::from(env_root);
        if is_product_root(&p) {
            return p;
        }
    }
    if let Some(configured) = cfg["projectRoot"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let p = PathBuf::from(configured);
        if is_product_root(&p) {
            return p;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(root) = walk_to_root(dir) {
                return root;
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = walk_to_root(&cwd) {
            return root;
        }
    }
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        if let Some(root) = walk_to_root(Path::new(manifest)) {
            return root;
        }
    }
    std::env::current_dir().unwrap_or_default()
}

fn resolve(cfg: &Value, root: &Path, key: &str) -> PathBuf {
    let rel = PathBuf::from(cfg[key].as_str().unwrap_or(""));
    if rel.is_absolute() {
        rel
    } else {
        root.join(rel)
    }
}

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> Value {
    load_config(&app)
}

#[tauri::command]
fn set_config(app: tauri::AppHandle, patch: Value) -> Value {
    let merged = merge(load_config(&app), patch);
    if let Ok(path) = config_path(&app) {
        let _ = std::fs::write(
            path,
            serde_json::to_string_pretty(&merged).unwrap_or_default(),
        );
    }
    merged
}

/// ffmpeg / ffprobe 的候选目录：exe 同目录、exe/bin、打包资源目录
fn tool_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            dirs.push(d.to_path_buf());
            dirs.push(d.join("bin"));
        }
    }
    if let Ok(rd) = app.path().resource_dir() {
        dirs.push(rd.clone());
        dirs.push(rd.join("bin"));
    }
    dirs
}

#[tauri::command]
fn env_check(app: tauri::AppHandle) -> Value {
    let cfg = load_config(&app);
    let root = detect_root(&cfg);
    let workspace = resolve(&cfg, &root, "comfyBase");
    let prompts = root.join("engine").join("prompts");
    let ffmpeg = kernel::find_tool(&tool_candidates(&app), &root, "ffmpeg");
    let ffprobe = kernel::find_tool(&tool_candidates(&app), &root, "ffprobe");

    json!({
        "configPath": config_path(&app).map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "projectRoot": root.to_string_lossy(),
        "comfyDir": workspace.to_string_lossy(),
        "comfyBase": workspace.to_string_lossy(),
        "comfyDirExists": workspace.is_dir(),
        "comfyBaseExists": workspace.is_dir(),
        "nodesInstalled": prompts.join("style-bible.json").is_file(),
        "venvPython": "",
        "venvExists": ffmpeg.is_some(),
        "ffmpegReady": ffmpeg.is_some() && ffprobe.is_some(),
        "torchInstalled": false,
        "llmKeySet": cfg["llm"]["apiKey"].as_str().map(|s| !s.trim().is_empty()).unwrap_or(false),
        "arkKeySet": cfg["ark"]["apiKey"].as_str().map(|s| !s.trim().is_empty()).unwrap_or(false),
        "llmModel": cfg["llm"]["model"],
        "llmBaseUrl": cfg["llm"]["baseUrl"],
        "comfyPort": cfg["comfyPort"]
    })
}

/// 内核常驻：原生执行器没有进程要拉，永远就绪。
/// comfyStatus 保留给前端的状态灯：running 恒真，端口字段只为兼容旧界面。
#[tauri::command]
async fn comfy_status() -> Value {
    json!({ "running": true, "port": 0, "native": true })
}

/// 兼容旧调用点：内核无需启动，立即就绪
#[tauri::command]
fn comfy_start() -> Result<Value, String> {
    Ok(json!({ "ok": true, "native": true }))
}

/// 前端的「停止」= 掐掉当前在跑的执行
#[tauri::command]
fn comfy_stop() -> Result<Value, String> {
    kernel::kernel_interrupt()
}


/// 产物的真身就在磁盘上（--base-directory 下的 output/）。
/// 把绝对路径交给前端，历史里的图/视频就不必依赖 ComfyUI 还开着才能看：
/// 引擎一停，/view 就 404，整页缩略图全变破图——那是我们自己的毛病。
#[tauri::command]
fn comfy_output_dir(app: tauri::AppHandle) -> Result<String, String> {
    let cfg = load_config(&app);
    let root = detect_root(&cfg);
    let dir = resolve(&cfg, &root, "comfyBase").join("output");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct OutFile {
    filename: String,
    subfolder: String,
    bytes: u64,
}

#[derive(serde::Serialize)]
struct CleanupResult {
    moved: usize,
    bytes: u64,
}

/// 递归列出 output/ 下所有文件（跳过 _trash 回收目录），
/// 给前端筛"没被任何执行记录引用的测试产物"用。
#[tauri::command]
fn comfy_output_list(app: tauri::AppHandle) -> Result<Vec<OutFile>, String> {
    let cfg = load_config(&app);
    let root = detect_root(&cfg);
    let dir = resolve(&cfg, &root, "comfyBase").join("output");
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let mut stack = vec![(dir, String::new())];
    while let Some((d, sub)) = stack.pop() {
        for entry in std::fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let name = p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if name == "_trash" {
                    continue;
                }
                let next_sub = if sub.is_empty() {
                    name
                } else {
                    format!("{sub}/{name}")
                };
                stack.push((p, next_sub));
            } else if p.is_file() {
                let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(OutFile {
                    filename: p
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                    subfolder: sub.clone(),
                    bytes,
                });
            }
        }
    }
    Ok(out)
}

/// 把指定的产物文件移进 output/_trash/（保留来源标记，重名带序号）——
/// 不真删文件，清理错了随时能从 _trash 捞回来。
#[tauri::command]
fn comfy_output_trash(app: tauri::AppHandle, items: Vec<OutFile>) -> Result<CleanupResult, String> {
    let cfg = load_config(&app);
    let root = detect_root(&cfg);
    let dir = resolve(&cfg, &root, "comfyBase").join("output");
    if !dir.is_dir() {
        return Err("输出目录不存在".into());
    }
    let dir_canon = dir.canonicalize().map_err(|e| e.to_string())?;
    let trash = dir.join("_trash");
    let path_safe = |s: &str| {
        !s.is_empty()
            && !s.contains("..")
            && !s.contains(':')
            && !s.starts_with('/')
            && !s.starts_with('\\')
    };
    let mut moved = 0usize;
    let mut bytes = 0u64;
    for it in items {
        // 严防路径逃逸：subfolder 不允许带 .. 或盘符，filename 只允许纯文件名
        if !path_safe(&it.subfolder)
            || it.filename.is_empty()
            || it.filename.contains('/')
            || it.filename.contains('\\')
            || it.filename.contains("..")
        {
            continue;
        }
        let src = dir.join(&it.subfolder).join(&it.filename);
        let src = match src.canonicalize() {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !src.starts_with(&dir_canon) || !src.is_file() {
            continue;
        }
        let dest_dir = trash.join(if it.subfolder.is_empty() {
            "root".to_string()
        } else {
            it.subfolder.replace(['/', '\\'], "_")
        });
        std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        let mut dest = dest_dir.join(&it.filename);
        let mut n = 2;
        while dest.exists() {
            let stem = std::path::Path::new(&it.filename)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".into());
            let ext = std::path::Path::new(&it.filename)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            dest = dest_dir.join(format!("{stem}_{n}{ext}"));
            n += 1;
        }
        if std::fs::rename(&src, &dest).is_ok() {
            moved += 1;
            bytes += it.bytes;
        }
    }
    Ok(CleanupResult { moved, bytes })
}

/* ---------------- 项目（工程文件夹）：一个项目一个真实文件夹 ---------------- */

/// 项目根目录：config.json 里的 projectsRoot 优先，否则默认 文档/StoryForgeProjects
fn projects_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let cfg = load_config(app);
    if let Some(p) = cfg.get("projectsRoot").and_then(|v| v.as_str()) {
        let p = p.trim();
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("无法定位文档目录: {e}"))?;
    Ok(base.join("StoryForgeProjects"))
}

/// 文件夹名清洗：去掉路径非法字符，别让项目名把目录搞坏
fn sanitize_dir_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        "未命名项目".into()
    } else {
        collapsed.chars().take(60).collect()
    }
}

#[derive(serde::Serialize)]
#[allow(non_snake_case)]
struct ProjectMeta {
    id: String,
    name: String,
    path: String,
    updatedAt: u64,
}

fn read_project_meta(dir: &Path) -> Option<ProjectMeta> {
    let meta_path = dir.join("project.json");
    let text = std::fs::read_to_string(&meta_path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("未命名项目")
        .to_string();
    let updated_at = dir
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(ProjectMeta {
        id: dir.file_name()?.to_string_lossy().to_string(),
        name,
        path: dir.to_string_lossy().to_string(),
        updatedAt: updated_at,
    })
}

#[tauri::command]
fn project_root(app: tauri::AppHandle) -> Result<String, String> {
    let dir = projects_root(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn project_set_root(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("路径不能为空".into());
    }
    std::fs::create_dir_all(&trimmed).map_err(|e| format!("目录无法创建: {e}"))?;
    let cfg_path = config_path(&app)?;
    let mut cfg = load_config(&app);
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert("projectsRoot".into(), json!(trimmed));
    }
    std::fs::write(&cfg_path, serde_json::to_string_pretty(&cfg).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    Ok(trimmed)
}

#[tauri::command]
fn project_list(app: tauri::AppHandle) -> Result<Vec<ProjectMeta>, String> {
    let dir = projects_root(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut out: Vec<ProjectMeta> = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() && p.join("project.json").is_file() {
            if let Some(meta) = read_project_meta(&p) {
                out.push(meta);
            }
        }
    }
    out.sort_by(|a, b| b.updatedAt.cmp(&a.updatedAt));
    Ok(out)
}

#[tauri::command]
fn project_load(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let dir = projects_root(&app)?.join(&id);
    // id 只允许是根目录下的直接文件夹名，防止 ../ 乱逛
    if id.contains('\\') || id.contains('/') || id.contains("..") {
        return Err("非法项目 id".into());
    }
    let meta_path = dir.join("project.json");
    std::fs::read_to_string(&meta_path).map_err(|e| format!("读取项目失败: {e}"))
}

#[tauri::command]
fn project_save(app: tauri::AppHandle, id: String, json: String) -> Result<(), String> {
    if id.contains('\\') || id.contains('/') || id.contains("..") {
        return Err("非法项目 id".into());
    }
    let dir = projects_root(&app)?.join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // 备份轮换：project.json.bak1/2/3。整包覆盖写是唯一副本，
    // 万一哪次把空骨架/坏数据盖上去，还有最近 3 版可以捞回来。
    // 轮换失败（被占用等）只跳过备份，不影响本次保存。
    let rotate = |from: &std::path::Path, to: &std::path::Path| {
        if !from.exists() {
            return;
        }
        if to.exists() {
            let _ = std::fs::remove_file(to);
        }
        let _ = std::fs::rename(from, to);
    };
    let meta_path = dir.join("project.json");
    rotate(&dir.join("project.json.bak2"), &dir.join("project.json.bak3"));
    rotate(&dir.join("project.json.bak1"), &dir.join("project.json.bak2"));
    rotate(&meta_path, &dir.join("project.json.bak1"));
    // 先写临时文件再改名，写一半断电也不至于把项目弄坏
    let tmp = dir.join("project.json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("写入项目失败: {e}"))?;
    std::fs::rename(&tmp, &meta_path).map_err(|e| format!("保存项目失败: {e}"))
}

#[tauri::command]
fn project_create(app: tauri::AppHandle, name: String) -> Result<ProjectMeta, String> {
    let root = projects_root(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let base = sanitize_dir_name(&name);
    // 重名就带序号：「项目 2」「项目 3」
    let mut dir = root.join(&base);
    let mut n = 2;
    while dir.exists() {
        dir = root.join(format!("{base} {n}"));
        n += 1;
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let final_name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
    let skeleton = json!({
        "schemaVersion": 1,
        "id": final_name,
        "name": final_name,
        "draft": serde_json::Value::Null,
        "sessions": [],
        "activeId": "",
        "savedAt": chrono_millis(),
    });
    std::fs::write(
        dir.join("project.json"),
        serde_json::to_string_pretty(&skeleton).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())?;
    Ok(ProjectMeta {
        id: final_name.clone(),
        name: final_name,
        path: dir.to_string_lossy().to_string(),
        updatedAt: chrono_millis(),
    })
}

#[tauri::command]
fn project_rename(app: tauri::AppHandle, id: String, name: String) -> Result<ProjectMeta, String> {
    if id.contains('\\') || id.contains('/') || id.contains("..") {
        return Err("非法项目 id".into());
    }
    let dir = projects_root(&app)?.join(&id);
    let meta_path = dir.join("project.json");
    let text = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let mut v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert("name".into(), json!(sanitize_dir_name(&name)));
    }
    std::fs::write(&meta_path, serde_json::to_string_pretty(&v).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    read_project_meta(&dir).ok_or_else(|| "读取项目元信息失败".into())
}

#[tauri::command]
fn project_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if id.contains('\\') || id.contains('/') || id.contains("..") {
        return Err("非法项目 id".into());
    }
    let dir = projects_root(&app)?.join(&id);
    if !dir.join("project.json").is_file() {
        return Err("项目不存在".into());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("删除项目失败: {e}"))
}

/// 把产物文件（成片 / 分镜视频）拷进项目的 export/ 文件夹，返回落点绝对路径。
/// 同名文件自动带序号，不覆盖已导出的东西。
#[tauri::command]
fn project_export_files(app: tauri::AppHandle, id: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    if id.contains('\\') || id.contains('/') || id.contains("..") {
        return Err("非法项目 id".into());
    }
    let dir = projects_root(&app)?.join(&id);
    if !dir.join("project.json").is_file() {
        return Err("项目不存在".into());
    }
    let export_dir = dir.join("export");
    std::fs::create_dir_all(&export_dir).map_err(|e| format!("创建 export 目录失败: {e}"))?;

    let mut out = Vec::new();
    for src in &paths {
        let from = std::path::Path::new(src);
        if !from.is_file() {
            return Err(format!("文件不存在：{}", src));
        }
        let base = from
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "export.mp4".into());
        let mut dest = export_dir.join(&base);
        // 重名带序号：name_2.mp4、name_3.mp4
        let mut n = 2;
        while dest.exists() {
            let stem = from
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "export".into());
            let ext = from
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            dest = export_dir.join(format!("{stem}_{n}{ext}"));
            n += 1;
        }
        std::fs::copy(from, &dest).map_err(|e| format!("拷贝失败：{e}"))?;
        out.push(dest.to_string_lossy().to_string());
    }
    Ok(out)
}

/// 把一段文本（分镜表 CSV 等）写进项目的 export/ 文件夹，返回落点绝对路径。
/// 重名自动带序号，不覆盖已导出的东西。
#[tauri::command]
fn project_write_export(
    app: tauri::AppHandle,
    id: String,
    filename: String,
    contents: String,
) -> Result<String, String> {
    if id.contains('\\') || id.contains('/') || id.contains("..") {
        return Err("非法项目 id".into());
    }
    let name = sanitize_dir_name(&filename);
    if name.is_empty() {
        return Err("文件名不能为空".into());
    }
    let dir = projects_root(&app)?.join(&id);
    if !dir.join("project.json").is_file() {
        return Err("项目不存在".into());
    }
    let export_dir = dir.join("export");
    std::fs::create_dir_all(&export_dir).map_err(|e| format!("创建 export 目录失败: {e}"))?;
    let mut dest = export_dir.join(&name);
    let mut n = 2;
    while dest.exists() {
        let stem = std::path::Path::new(&name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "export".into());
        let ext = std::path::Path::new(&name)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        dest = export_dir.join(format!("{stem}_{n}{ext}"));
        n += 1;
    }
    std::fs::write(&dest, contents.as_bytes()).map_err(|e| format!("写入失败：{e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

fn chrono_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
async fn llm_chat(
    app: tauri::AppHandle,
    messages: Vec<Value>,
    model: Option<String>,
    temperature: Option<f64>,
    json_mode: Option<bool>,
) -> Result<Value, String> {
    let cfg = load_config(&app);
    let key = cfg["llm"]["apiKey"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if key.is_empty() {
        return Err("NO_KEY".into());
    }
    let base = cfg["llm"]["baseUrl"]
        .as_str()
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    let mdl = model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| cfg["llm"]["model"].as_str().map(|s| s.to_string()))
        .unwrap_or_default();
    if mdl.is_empty() {
        return Err("NO_MODEL".into());
    }

    let mut body = json!({
        "model": mdl,
        "messages": messages,
        "temperature": temperature.unwrap_or(0.3)
    });
    if json_mode.unwrap_or(false) {
        body["response_format"] = json!({ "type": "json_object" });
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{base}/chat/completions"))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}"));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("解析失败：{e}"))?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string());
    Ok(json!({
        "content": content,
        "usage": v.get("usage").cloned().unwrap_or(Value::Null)
    }))
}

/// 流式对话：逐块 emit `llm://delta`，前端按 streamId 订阅。
/// 用 `Response::chunk()` 读 SSE，不引入额外依赖。
#[tauri::command]
async fn llm_chat_stream(
    app: tauri::AppHandle,
    stream_id: String,
    messages: Vec<Value>,
    model: Option<String>,
    temperature: Option<f64>,
    json_mode: Option<bool>,
) -> Result<Value, String> {
    use tauri::Emitter;

    let cfg = load_config(&app);
    let key = cfg["llm"]["apiKey"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if key.is_empty() {
        return Err("NO_KEY".into());
    }
    let base = cfg["llm"]["baseUrl"]
        .as_str()
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    let mdl = model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| cfg["llm"]["model"].as_str().map(|s| s.to_string()))
        .unwrap_or_default();
    if mdl.is_empty() {
        return Err("NO_MODEL".into());
    }

    let mut body = json!({
        "model": mdl,
        "messages": messages,
        "temperature": temperature.unwrap_or(0.3),
        "stream": true,
        "stream_options": { "include_usage": true }
    });
    if json_mode.unwrap_or(false) {
        body["response_format"] = json!({ "type": "json_object" });
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client
        .post(format!("{base}/chat/completions"))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }

    let mut buf = String::new();
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut usage = Value::Null;
    let mut finish = String::new();

    // 注册中断旗标：前端 llm_abort 立起来后，下面的循环会尽快退出
    let aborted_flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = llm_streams().lock() {
        map.insert(stream_id.clone(), aborted_flag.clone());
    }
    let mut cancelled = false;

    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("读取流失败：{e}"))? {
        if aborted_flag.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buf.find('\n') {
            let line = buf[..idx].trim_end_matches('\r').to_string();
            buf.drain(..=idx);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(u) = v.get("usage") {
                if !u.is_null() {
                    usage = u.clone();
                }
            }
            let Some(choice) = v.get("choices").and_then(|c| c.get(0)) else {
                continue;
            };
            // 结束原因：length = 额度烧完了（常见于只输出思考没输出正文）
            if let Some(fr) = choice.get("finish_reason").and_then(|x| x.as_str()) {
                finish = fr.to_string();
            }
            let Some(delta) = choice.get("delta") else {
                continue;
            };
            if let Some(t) = delta.get("reasoning_content").and_then(|x| x.as_str()) {
                if !t.is_empty() {
                    reasoning.push_str(t);
                    let _ = app.emit(
                        "llm://delta",
                        json!({ "streamId": stream_id, "kind": "reasoning", "text": t }),
                    );
                }
            }
            if let Some(t) = delta.get("content").and_then(|x| x.as_str()) {
                if !t.is_empty() {
                    content.push_str(t);
                    let _ = app.emit(
                        "llm://delta",
                        json!({ "streamId": stream_id, "kind": "content", "text": t }),
                    );
                }
            }
        }
    }

    // 收尾：把旗标摘掉，别在表里越攒越多
    if let Ok(mut map) = llm_streams().lock() {
        map.remove(&stream_id);
    }

    Ok(json!({
        "content": content,
        "reasoning": reasoning,
        "usage": usage,
        "finishReason": finish,
        "cancelled": cancelled
    }))
}

#[tauri::command]
fn assemble_shots(
    app: tauri::AppHandle,
    run_id: String,
    files: Vec<Value>,
    title: String,
) -> Result<Value, String> {
    let cfg = load_config(&app);
    let root = detect_root(&cfg);
    let ffmpeg = kernel::find_tool(&tool_candidates(&app), &root, "ffmpeg")
        .ok_or("找不到 ffmpeg（拼接成片需要它）。请把 ffmpeg.exe 放进项目根的 bin/ 文件夹，或重新安装完整版。")?;
    let ffprobe = kernel::find_tool(&tool_candidates(&app), &root, "ffprobe");

    let base_dir = resolve(&cfg, &root, "comfyBase");
    let mut paths: Vec<PathBuf> = Vec::new();
    for f in &files {
        let filename = f
            .get("filename")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let subfolder = f
            .get("subfolder")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if filename.is_empty() {
            continue;
        }
        let path = base_dir.join("output").join(&subfolder).join(&filename);
        if !path.exists() {
            return Err(format!("找不到产物文件：{}", path.display()));
        }
        paths.push(path);
    }
    if paths.is_empty() {
        return Err("没有可拼接的视频".into());
    }

    let safe: String = title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' { c } else { '_' })
        .collect();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let out_name = format!("film_{}_{}.mp4", safe, ts);
    let out_dir = base_dir
        .join("output")
        .join("storyforge")
        .join("film");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let out_path = out_dir.join(&out_name);

    kernel::ffmpeg_concat(&ffmpeg, &paths, &out_path)
        .map_err(|e| format!("拼接失败：{e}"))?;

    let duration = ffprobe.and_then(|p| kernel::probe_duration(&p, &out_path));

    Ok(json!({
        "ok": true,
        "runId": run_id,
        "filename": out_name,
        "subfolder": "storyforge/film",
        "duration": duration.map(|d| json!(d)).unwrap_or(Value::Null),
    }))
}

/// 前端提交执行图。内核命令需要的路径与凭证都由这里从配置解析后传入。
#[tauri::command]
fn kernel_submit_cmd(
    app: tauri::AppHandle,
    graph: Value,
    client_id: String,
) -> Result<Value, String> {
    let cfg = load_config(&app);
    let root = detect_root(&cfg);
    let workspace = resolve(&cfg, &root, "comfyBase");
    let out_dir = workspace.join("output");
    let prompts_dir = root.join("engine").join("prompts");

    let ark_key = cfg["ark"]["apiKey"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let k = cfg["llm"]["apiKey"].as_str().unwrap_or("").trim();
            if k.starts_with("ark-") {
                Some(k)
            } else {
                None
            }
        })
        .unwrap_or("")
        .to_string();

    let ffmpeg = kernel::find_tool(&tool_candidates(&app), &root, "ffmpeg")
        .ok_or("找不到 ffmpeg（占位图 / 缩放 / 尾帧都靠它）。请把 ffmpeg.exe 放进项目根的 bin/ 文件夹，或重新安装完整版。")?;
    let ffprobe = kernel::find_tool(&tool_candidates(&app), &root, "ffprobe").unwrap_or(ffmpeg.clone());

    kernel::kernel_submit(app, graph, client_id, out_dir.to_string_lossy().to_string(), prompts_dir.to_string_lossy().to_string(), ark_key, ffmpeg.to_string_lossy().to_string(), ffprobe.to_string_lossy().to_string())
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    let target = if std::path::Path::new(&path).is_dir() {
        path
    } else {
        std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path)
    };
    Command::new("explorer")
        .arg(target)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            env_check,
            comfy_status,
            comfy_start,
            comfy_stop,
            comfy_output_dir,
            comfy_output_list,
            comfy_output_trash,
            kernel_submit_cmd,
            kernel::kernel_history,
            kernel::kernel_interrupt,
            llm_chat,
            llm_chat_stream,
            llm_abort,
            assemble_shots,
            open_in_explorer,
            project_root,
            project_set_root,
            project_list,
            project_load,
            project_save,
            project_create,
            project_rename,
            project_delete,
            project_export_files,
            project_write_export
        ])
        .run(tauri::generate_context!())
        .expect("StoryForge 启动失败");
}
