//! StoryForge 原生内核：替代 ComfyUI 的本地执行器。
//!
//! 画布永远是 ComfyUI API 格式的图（"画布是唯一真相"），内核只做三件事：
//!   1. 拓扑执行图里的节点（只认 StoryForge 自家的 10 个节点，其余一律拒绝）；
//!   2. 需要生成力的节点直连火山 ARK（文生图 / 图生视频，逻辑对齐原 nodes.py）；
//!   3. 像素级杂活（占位图、缩放、抽尾帧）交给随包分发的 ffmpeg。
//!
//! 对前端的契约与 ComfyUI 完全同构：
//!   - 提交 → kernel_submit，返回 prompt_id；
//!   - 进度 → `kernel://event` 事件，消息形状对齐 /ws（executing/progress/executed/…）；
//!   - 历史 → kernel_history，形状对齐 /history/{prompt_id}（status + outputs）。
//! 所以前端的 ComfyClient 换成内核客户端后，agent.ts / store.ts 的执行流一行不用改。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const ARK_BASE: &str = "https://ark.cn-beijing.volces.com/api/v3";

/// 内核认识的全部节点。图里出现不在这里的 class_type 直接拒收——
/// 394 节点库的时代结束了，这条白名单就是新的执行边界。
pub const KERNEL_NODES: &[&str] = &[
    "DramaCharacter",
    "DramaShotFrame",
    "DramaShotVideo",
    "DramaContinuity",
    "StoryForgeSeedream",
    "StoryForgeSeedance",
    "SaveImage",
    "SaveVideo",
    "EmptyImage",
    "ImageScale",
    "LoadImage",
    "LoadVideo",
];

// ---------------------------------------------------------------------------
// 运行登记表：prompt_id → 状态 / 产物 / 取消旗标（对应 ComfyUI 的队列 + /history）
// ---------------------------------------------------------------------------

struct RunInfo {
    cancel: AtomicBool,
    status: Mutex<String>, // running / success / error
    outputs: Mutex<Value>, // nodeId → { images: [...], videos: [...] }
    error: Mutex<String>,
}

impl RunInfo {
    fn new() -> Self {
        Self {
            cancel: AtomicBool::new(false),
            status: Mutex::new("running".into()),
            outputs: Mutex::new(json!({})),
            error: Mutex::new(String::new()),
        }
    }
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

static RUNS: OnceLock<Mutex<HashMap<String, Arc<RunInfo>>>> = OnceLock::new();
static COUNTER: AtomicU64 = AtomicU64::new(0);

fn runs() -> &'static Mutex<HashMap<String, Arc<RunInfo>>> {
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// prompt_id：时间戳 + 计数器，够独特也够短（前端取前 8 位当 run id）
fn new_prompt_id() -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{ts:x}{n:04x}")
}

// ---------------------------------------------------------------------------
// 节点值：图里流动的数据。图片就是字节（PNG 为主）+ 可选的原始 URL
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum NodeVal {
    /// 图片：字节 + mime（组 data URL 用）+ Seedream 返回的原始 URL（Seedance 只信这个）
    Image(Arc<ImageVal>),
    /// 视频：磁盘上的 mp4 + 已知时长
    Video(Arc<VideoVal>),
    /// 字符串（DramaCharacter 的 source_url 等）
    Str(String),
}

#[derive(Clone)]
struct ImageVal {
    bytes: Vec<u8>,
    mime: String,
    source_url: String,
}

impl ImageVal {
    fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.mime, B64.encode(&self.bytes))
    }
}

#[derive(Clone)]
struct VideoVal {
    path: PathBuf,
    duration: Option<f64>,
}

// ---------------------------------------------------------------------------
// 提示词资产：engine/prompts/*.json，缺失时退回内置默认
// ---------------------------------------------------------------------------

const BIBLE_FALLBACK: &str = r#"{
  "default_style": "竖屏 9:16 电影短剧画面，真实电影质感，冷调低饱和，浅景深，画面无文字无水印",
  "character_sheet": "角色定妆照，单人，正面，纯色背景，柔和布光，细节清晰",
  "frame_suffix": "竖屏 9:16 电影分镜，画面无文字无水印",
  "continuity": "保持参考图中人物的五官、发型、服装与影调一致"
}"#;

const GRAMMAR_FALLBACK: &str = r#"{"shot_sizes": {}, "cameras": {}}"#;

const NEGATIVE_FALLBACK: &str = r#"{
  "default": "文字，字幕，水印，畸形手指，多余肢体，面部扭曲，低清晰度",
  "character": "多人同框，重复人脸，杂乱背景",
  "frame": "人物变形，服装不一致，场景错乱",
  "video": "画面闪烁，人物变形，动作僵硬"
}"#;

fn load_json_dir(dir: &Path, name: &str, fallback: &str) -> Value {
    for candidate in [dir.join(name)] {
        if let Ok(text) = std::fs::read_to_string(&candidate) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if v.is_object() {
                    return v;
                }
            }
        }
    }
    serde_json::from_str(fallback).unwrap_or(json!({}))
}

/// 逐段拼接提示词：去首尾句号后用中文句号连接（对齐原 nodes.py 的 _join）
fn join_prompt(parts: &[&str]) -> String {
    parts
        .iter()
        .map(|p| p.trim().trim_matches('。'))
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("。")
}

// ---------------------------------------------------------------------------
// 执行上下文
// ---------------------------------------------------------------------------

struct RunCtx {
    app: AppHandle,
    client_id: String,
    prompt_id: String,
    run: Arc<RunInfo>,
    key: String,
    out_dir: PathBuf,
    tmp_dir: PathBuf,
    prompts_dir: PathBuf,
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
    http: reqwest::Client,
}

impl RunCtx {
    fn emit(&self, msg: Value) {
        let _ = self.app.emit(
            "kernel://event",
            json!({
                "clientId": self.client_id,
                "promptId": self.prompt_id,
                "msg": msg,
            }),
        );
    }

    fn emit_node(&self, kind: &str, node: &str) {
        self.emit(json!({ "type": kind, "node": node }));
    }

    fn check_cancel(&self) -> Result<(), String> {
        if self.run.cancelled() {
            Err("__cancelled__".into())
        } else {
            Ok(())
        }
    }

    /// 把产物登记进历史（形状对齐 ComfyUI 的 outputs）
    fn record_output(&self, node: &str, key: &str, file: Value) {
        let mut outputs = self.run.outputs.lock().unwrap();
        let entry = outputs.as_object_mut().unwrap().entry(node.to_string()).or_insert_with(|| json!({}));
        let arr = entry
            .as_object_mut()
            .unwrap()
            .entry(key.to_string())
            .or_insert_with(|| json!([]));
        arr.as_array_mut().unwrap().push(file);
    }
}

// ---------------------------------------------------------------------------
// ARK 调用（对齐原 nodes.py）
// ---------------------------------------------------------------------------

async fn ark_post(ctx: &RunCtx, path: &str, body: &Value, timeout: u64) -> Result<Value, String> {
    let resp = ctx
        .http
        .post(format!("{ARK_BASE}{path}"))
        .bearer_auth(&ctx.key)
        .json(body)
        .timeout(Duration::from_secs(timeout))
        .send()
        .await
        .map_err(|e| format!("ARK 请求失败：{e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if status >= 400 {
        return Err(format!("ARK 调用失败 HTTP {status}: {}", &text[..text.len().min(800)]));
    }
    serde_json::from_str(&text).map_err(|e| format!("ARK 响应解析失败：{e}｜{}", &text[..text.len().min(300)]))
}

async fn ark_get(ctx: &RunCtx, path: &str) -> Result<Value, String> {
    let resp = ctx
        .http
        .get(format!("{ARK_BASE}{path}"))
        .bearer_auth(&ctx.key)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("ARK 查询失败：{e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if status >= 400 {
        return Err(format!("ARK 查询失败 HTTP {status}: {}", &text[..text.len().min(500)]));
    }
    serde_json::from_str(&text).map_err(|e| format!("ARK 响应解析失败：{e}"))
}

async fn download(ctx: &RunCtx, url: &str) -> Result<Vec<u8>, String> {
    let resp = ctx
        .http
        .get(url)
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| format!("下载产物失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载产物失败 HTTP {}", resp.status()));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("读取产物失败：{e}"))
}

/// 文生图：/images/generations。参考图一律转 data URL（与原 nodes.py 一致）。
/// 返回 (图片字节, 原始 URL)。
async fn ark_image(
    ctx: &RunCtx,
    prompt: &str,
    model: &str,
    size: &str,
    refs: &[ImageVal],
    negative: &str,
    watermark: bool,
) -> Result<ImageVal, String> {
    let mut text = prompt.to_string();
    if !negative.trim().is_empty() {
        text = format!("{prompt}\n\n画面中避免出现：{}", negative.trim());
    }
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("prompt".into(), json!(text));
    body.insert("size".into(), json!(size));
    body.insert("output_format".into(), json!("png"));
    body.insert("response_format".into(), json!("url"));
    body.insert("watermark".into(), json!(watermark));
    match refs.len() {
        0 => {}
        1 => {
            body.insert("image".into(), json!(refs[0].data_url()));
        }
        _ => {
            body.insert(
                "image".into(),
                json!(refs.iter().map(|r| Value::String(r.data_url())).collect::<Vec<_>>()),
            );
        }
    }

    let data = ark_post(ctx, "/images/generations", &Value::Object(body), 600).await?;
    let items = data.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
    let first = items
        .first()
        .cloned()
        .ok_or_else(|| format!("Seedream 未返回图片: {}", truncate(&data.to_string(), 500)))?;
    if let Some(b64) = first.get("b64_json").and_then(|v| v.as_str()) {
        let bytes = B64
            .decode(b64)
            .map_err(|e| format!("Seedream 图片解码失败：{e}"))?;
        return Ok(ImageVal { bytes, mime: "image/png".into(), source_url: String::new() });
    }
    let url = first
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Seedream 未返回图片地址: {}", truncate(&first.to_string(), 500)))?
        .to_string();
    let bytes = download(ctx, &url).await?;
    Ok(ImageVal { bytes, mime: "image/png".into(), source_url: url })
}

/// 图生视频：/contents/generations/tasks + 5s 轮询 + 25 分钟超时。
/// 首帧被真人审核拦截时，自动降级为角色参考图模式重试（与原 nodes.py 一致）。
#[allow(clippy::too_many_arguments)]
async fn ark_video(
    ctx: &RunCtx,
    node: &str,
    prompt: &str,
    model: &str,
    first_frame: Option<&ImageVal>,
    last_frame: Option<&ImageVal>,
    first_frame_url: &str,
    last_frame_url: &str,
    duration: i64,
    ratio: &str,
    resolution: &str,
    generate_audio: bool,
    watermark: bool,
    reference_urls: &[String],
    reference_prompt: &str,
) -> Result<VideoVal, String> {
    if duration != -1 && duration < 4 {
        return Err("视频时长最短 4 秒".into());
    }
    if duration > 30 {
        return Err("视频时长最长 30 秒".into());
    }
    if !model.contains("2-5") && duration > 15 {
        return Err(format!("{model} 最长 15 秒，请把 duration 改小"));
    }

    let first_src = first_frame_url.trim();
    let last_src = last_frame_url.trim();
    let has_first = !first_src.is_empty() || first_frame.is_some();
    let refs: Vec<String> = reference_urls
        .iter()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .collect();

    let build_body = |first_mode: bool| -> Value {
        let text = if first_mode {
            prompt.to_string()
        } else if !reference_prompt.trim().is_empty() {
            reference_prompt.trim().to_string()
        } else {
            prompt.to_string()
        };
        let mut content = vec![json!({ "type": "text", "text": text })];
        if first_mode {
            if let Some(src) = first_src.strip_default(first_frame) {
                content.push(json!({
                    "type": "image_url", "role": "first_frame",
                    "image_url": { "url": src }
                }));
            }
            if let Some(src) = last_src
                .non_empty()
                .map(|s| s.to_string())
                .or(last_frame.map(|f| f.data_url()))
            {
                content.push(json!({
                    "type": "image_url", "role": "last_frame",
                    "image_url": { "url": src }
                }));
            }
        } else {
            for u in &refs {
                content.push(json!({
                    "type": "image_url", "role": "reference_image",
                    "image_url": { "url": u }
                }));
            }
        }
        let use_ratio = if first_mode {
            "adaptive".to_string()
        } else if !refs.is_empty() && ratio == "adaptive" {
            "9:16".to_string()
        } else {
            ratio.to_string()
        };
        json!({
            "model": model,
            "content": content,
            "generate_audio": generate_audio,
            "ratio": use_ratio,
            "duration": duration,
            "resolution": resolution,
            "output_format": "mp4",
            "watermark": watermark,
        })
    };

    // 首帧优先：原始 URL 比重编码的 data URL 更受 Seedance 信任
    let first_body = if has_first { build_body(true) } else { build_body(false) };
    let created = match ark_post(ctx, "/contents/generations/tasks", &first_body, 120).await {
        Ok(v) => v,
        Err(err) => {
            // 首帧被判定"疑似真人"：改用角色定妆图的原始 URL 走参考图模式重试
            if has_first
                && !refs.is_empty()
                && err.contains("InputImageSensitiveContentDetected.PrivacyInformation")
            {
                ctx.emit(json!({ "type": "progress", "node": node, "detail": "首帧被审核拦截，改用角色参考图模式重试" }));
                ark_post(ctx, "/contents/generations/tasks", &build_body(false), 120).await?
            } else {
                return Err(err);
            }
        }
    };

    let task_id = created
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Seedance 未返回任务 ID: {}", truncate(&created.to_string(), 400)))?
        .to_string();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(25 * 60);
    let mut video_url = String::new();
    let mut last_status = String::new();
    let started = std::time::Instant::now();
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(5)).await;
        ctx.check_cancel()?;
        let info = ark_get(ctx, &format!("/contents/generations/tasks/{task_id}")).await?;
        let status = info.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if !status.is_empty() {
            last_status = status.clone();
            // 轮询进度：播报已等待秒数，画布上的进度条至少知道它活着
            let secs = started.elapsed().as_secs();
            ctx.emit(json!({ "type": "progress", "node": node, "detail": format!("生成中 · {secs}s · {status}") }));
        }
        if status == "succeeded" {
            video_url = info
                .pointer("/content/video_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            break;
        }
        if matches!(status.as_str(), "failed" | "expired" | "cancelled") {
            return Err(format!("Seedance 任务 {status}: {}", truncate(&info.to_string(), 800)));
        }
    }
    if video_url.is_empty() {
        return Err(format!(
            "Seedance 任务超时（最后状态：{}）",
            if last_status.is_empty() { "unknown" } else { &last_status }
        ));
    }

    let bytes = download(ctx, &video_url).await?;
    std::fs::create_dir_all(&ctx.tmp_dir).map_err(|e| e.to_string())?;
    let path = ctx.tmp_dir.join(format!("seedance_{}.mp4", new_prompt_id()));
    std::fs::write(&path, &bytes).map_err(|e| format!("落盘视频失败：{e}"))?;
    Ok(VideoVal { path, duration: None })
}

trait UrlOpt {
    fn non_empty(&self) -> Option<&str>;
    /// 优先原始 URL，其次把图片转成 data URL
    fn strip_default(&self, img: Option<&ImageVal>) -> Option<String>;
}

impl UrlOpt for &str {
    fn non_empty(&self) -> Option<&str> {
        if self.trim().is_empty() {
            None
        } else {
            Some(self.trim())
        }
    }
    fn strip_default(&self, img: Option<&ImageVal>) -> Option<String> {
        self.non_empty()
            .map(|s| s.to_string())
            .or_else(|| img.map(|i| i.data_url()))
    }
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ---------------------------------------------------------------------------
// ffmpeg 杂活：占位图 / 缩放 / 抽尾帧 / 探时长
// ---------------------------------------------------------------------------

fn run_ffmpeg(bin: &Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = std::process::Command::new(bin);
    cmd.args(args);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .output()
        .map_err(|e| format!("启动 ffmpeg 失败：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "ffmpeg 执行失败：{}",
            truncate(&err, 600)
        ));
    }
    Ok(())
}

/// 纯色占位图（替代 ComfyUI 的 EmptyImage + torch）
fn ffmpeg_empty_image(ctx: &RunCtx, color: i64, width: i64, height: i64) -> Result<ImageVal, String> {
    let out = ctx.tmp_dir.join(format!("empty_{}.png", new_prompt_id()));
    std::fs::create_dir_all(&ctx.tmp_dir).map_err(|e| e.to_string())?;
    let hex = format!("0x{:06x}", color & 0xFF_FFFF);
    let size = format!("{width}x{height}");
    run_ffmpeg(
        &ctx.ffmpeg,
        &[
            "-y", "-f", "lavfi", "-i", &format!("color=c={hex}:s={size}"),
            "-frames:v", "1", "-update", "1",
            out.to_str().ok_or("路径含非法字符")?,
        ],
    )?;
    let bytes = std::fs::read(&out).map_err(|e| format!("读取占位图失败：{e}"))?;
    Ok(ImageVal { bytes, mime: "image/png".into(), source_url: String::new() })
}

/// 缩放（ImageScale）：lanczos/bilinear/bicubic/nearest/area → ffmpeg scale 滤镜
fn ffmpeg_scale(ctx: &RunCtx, img: &ImageVal, method: &str, w: i64, h: i64, crop: &str) -> Result<ImageVal, String> {
    let src = ctx.tmp_dir.join(format!("scale_in_{}.png", new_prompt_id()));
    let dst = ctx.tmp_dir.join(format!("scale_out_{}.png", new_prompt_id()));
    std::fs::create_dir_all(&ctx.tmp_dir).map_err(|e| e.to_string())?;
    std::fs::write(&src, &img.bytes).map_err(|e| e.to_string())?;
    let flags = match method {
        "nearest-exact" | "nearest" => "neighbor",
        "bilinear" => "bilinear",
        "bicubic" => "bicubic",
        "area" => "area",
        _ => "lanczos",
    };
    let mut vf = format!("scale={w}:{h}:flags={flags}");
    if crop == "center" {
        vf.push_str(&format!(",crop={w}:{h}"));
    }
    run_ffmpeg(
        &ctx.ffmpeg,
        &["-y", "-i", src.to_str().ok_or("路径含非法字符")?, "-vf", &vf, dst.to_str().ok_or("路径含非法字符")?],
    )?;
    let bytes = std::fs::read(&dst).map_err(|e| format!("读取缩放结果失败：{e}"))?;
    Ok(ImageVal { bytes, mime: "image/png".into(), source_url: String::new() })
}

/// 抽视频最后一帧（DramaContinuity）：-sseof 从结尾往前找，取 1 帧
fn ffmpeg_last_frame(ctx: &RunCtx, video: &Path) -> Result<ImageVal, String> {
    let out = ctx.tmp_dir.join(format!("tail_{}.png", new_prompt_id()));
    std::fs::create_dir_all(&ctx.tmp_dir).map_err(|e| e.to_string())?;
    run_ffmpeg(
        &ctx.ffmpeg,
        &[
            "-y", "-sseof", "-0.5", "-i", video.to_str().ok_or("路径含非法字符")?,
            "-frames:v", "1", "-update", "1",
            out.to_str().ok_or("路径含非法字符")?,
        ],
    )?;
    let bytes = std::fs::read(&out).map_err(|e| format!("读取尾帧失败：{e}"))?;
    if bytes.is_empty() {
        return Err("视频里没有可用的画面帧".into());
    }
    Ok(ImageVal { bytes, mime: "image/png".into(), source_url: String::new() })
}

pub fn probe_duration(ffprobe: &Path, file: &Path) -> Option<f64> {
    ffprobe_duration(ffprobe, file)
}

fn ffprobe_duration(ffprobe: &Path, file: &Path) -> Option<f64> {
    let mut cmd = std::process::Command::new(ffprobe);
    cmd.args([
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        file.to_str()?,
    ]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// 成片拼接（替代 assemble.py 的 PyAV 重编码）：concat demuxer + libx264 重编码，
/// 参数取第一个输入，画质损失可忽略。
pub fn ffmpeg_concat(ffmpeg: &Path, inputs: &[PathBuf], out_path: &Path) -> Result<(), String> {
    let list_path = out_path
        .parent()
        .unwrap_or(Path::new("."))
        .join(format!("concat_{}.txt", new_prompt_id()));
    let mut list = String::new();
    for p in inputs {
        // concat demuxer 要求单引号转义
        let s = p.to_string_lossy().replace('\'', "'\\''");
        list.push_str(&format!("file '{s}'\n"));
    }
    std::fs::write(&list_path, list).map_err(|e| format!("写拼接清单失败：{e}"))?;
    let result = run_ffmpeg(
        ffmpeg,
        &[
            "-y", "-f", "concat", "-safe", "0", "-i",
            list_path.to_str().ok_or("路径含非法字符")?,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-c:a", "aac",
            out_path.to_str().ok_or("路径含非法字符")?,
        ],
    );
    let _ = std::fs::remove_file(&list_path);
    result
}

// ---------------------------------------------------------------------------
// 图执行器
// ---------------------------------------------------------------------------

struct NodeDef {
    class_type: String,
    inputs: Value,
}

/// 收集图 + 静态校验：未知节点 / 断线引用直接拒收（对齐 ComfyUI 提交时的校验行为）
fn parse_graph(graph: &Value) -> Result<HashMap<String, NodeDef>, String> {
    let obj = graph
        .as_object()
        .ok_or("图不是一个对象（应为 { node_id: { class_type, inputs } }）")?;
    if obj.is_empty() {
        return Err("图里没有任何节点".into());
    }
    let mut nodes = HashMap::new();
    for (id, def) in obj {
        let class_type = def
            .get("class_type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("节点 {id} 缺少 class_type"))?;
        if !KERNEL_NODES.contains(&class_type) {
            return Err(format!(
                "节点 {id} 的 class_type \"{class_type}\" 不在内核支持列表里。原生内核只执行 StoryForge 节点与基础图像节点，不再支持第三方 ComfyUI 节点。"
            ));
        }
        nodes.insert(
            id.clone(),
            NodeDef {
                class_type: class_type.to_string(),
                inputs: def.get("inputs").cloned().unwrap_or(json!({})),
            },
        );
    }
    // 连线引用必须指向存在的节点
    for (id, def) in &nodes {
        if let Some(inputs) = def.inputs.as_object() {
            for (k, v) in inputs {
                if is_link(v) {
                    let upstream = &v[0].as_str().unwrap_or("");
                    if !nodes.contains_key(*upstream) {
                        return Err(format!(
                            "节点 {id} 的 \"{k}\" 连到了不存在的节点 {upstream}"
                        ));
                    }
                }
            }
        }
    }
    Ok(nodes)
}

fn is_link(v: &Value) -> bool {
    v.is_array() && v.as_array().map(|a| a.len() == 2 && a[0].is_string()).unwrap_or(false)
}

/// 拓扑排序（DFS）；环 → 报错
fn topo_order(nodes: &HashMap<String, NodeDef>) -> Result<Vec<String>, String> {
    let mut order = Vec::new();
    let mut state: HashMap<String, u8> = HashMap::new(); // 0=在栈 1=完成
    for id in nodes.keys() {
        visit(id, nodes, &mut state, &mut order)?;
    }
    Ok(order)
}

fn visit(
    id: &str,
    nodes: &HashMap<String, NodeDef>,
    state: &mut HashMap<String, u8>,
    order: &mut Vec<String>,
) -> Result<(), String> {
    match state.get(id) {
        Some(1) => return Ok(()),
        Some(0) => return Err("图里有环：连线形成了循环依赖".into()),
        _ => {}
    }
    state.insert(id.to_string(), 0);
    if let Some(def) = nodes.get(id) {
        if let Some(inputs) = def.inputs.as_object() {
            for v in inputs.values() {
                if is_link(v) {
                    let upstream_id = v[0].as_str().unwrap_or("");
                    if nodes.contains_key(upstream_id) {
                        visit(upstream_id, nodes, state, order)?;
                    }
                }
            }
        }
    }
    state.insert(id.to_string(), 1);
    order.push(id.to_string());
    Ok(())
}

/// 取输入里的上游产物；不是连线就原样返回 None（由节点函数自己读标量）
fn upstream<'a>(
    id: &str,
    key: &str,
    slot: usize,
    nodes: &HashMap<String, NodeDef>,
    produced: &'a HashMap<String, Vec<NodeVal>>,
) -> Option<&'a NodeVal> {
    let def = nodes.get(id)?;
    let v = def.inputs.get(key)?;
    if !is_link(v) {
        return None;
    }
    let upstream_id = v[0].as_str()?;
    let outs = produced.get(upstream_id)?;
    outs.get(slot)
}

/// 逐节点执行；产物存进 produced；Save* 节点登记历史输出。
async fn execute_node(
    ctx: &RunCtx,
    id: &str,
    nodes: &HashMap<String, NodeDef>,
    produced: &mut HashMap<String, Vec<NodeVal>>,
    assets_counter: &mut u64,
) -> Result<Vec<NodeVal>, String> {
    let def = nodes.get(id).ok_or("节点丢失")?;
    let inp_str = |key: &str| -> String {
        def.inputs
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let inp_bool = |key: &str| -> bool {
        def.inputs.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
    };
    let img = |val: Option<&NodeVal>| -> Option<ImageVal> {
        match val {
            Some(NodeVal::Image(i)) => Some((**i).clone()),
            _ => None,
        }
    };
    let as_string = |val: Option<&NodeVal>| -> String {
        match val {
            Some(NodeVal::Str(s)) => s.clone(),
            _ => String::new(),
        }
    };
    let video = |val: Option<&NodeVal>| -> Option<VideoVal> {
        match val {
            Some(NodeVal::Video(v)) => Some((**v).clone()),
            _ => None,
        }
    };
    let bible = load_json_dir(&ctx.prompts_dir, "style-bible.json", BIBLE_FALLBACK);
    let grammar = load_json_dir(&ctx.prompts_dir, "shot-grammar.json", GRAMMAR_FALLBACK);
    let negative = load_json_dir(&ctx.prompts_dir, "negative.json", NEGATIVE_FALLBACK);
    let neg_default = negative["default"].as_str().unwrap_or("");
    fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
        v[k].as_str().unwrap_or("")
    }

    match def.class_type.as_str() {
        /* ---------------- 生成：ARK ---------------- */
        "DramaCharacter" => {
            let anchor = inp_str("anchor");
            if anchor.trim().is_empty() {
                return Err("角色定妆缺少 anchor（外貌/服装/气质锚点）".into());
            }
            let name = inp_str("name");
            let style = inp_str("style");
            let framing = inp_str("framing");
            let style_prefix = if style.trim().is_empty() {
                str_of(&bible, "default_style")
            } else {
                style.trim()
            };
            let prompt = join_prompt(&[
                style_prefix,
                &format!("角色定妆照：{}，{}", name.trim(), anchor.trim()),
                &format!("{}构图", framing),
                str_of(&bible, "character_sheet"),
            ]);
            let neg = join_prompt(&[neg_default, str_of(&negative, "character")]);
            let image = ark_image(
                ctx,
                &prompt,
                &inp_str("model"),
                &inp_str("size"),
                &[],
                &neg,
                inp_bool("watermark"),
            )
            .await?;
            let url = image.source_url.clone();
            Ok(vec![NodeVal::Image(Arc::new(image)), NodeVal::Str(url)])
        }

        "DramaShotFrame" => {
            let style = inp_str("style");
            let style_prefix = if style.trim().is_empty() {
                str_of(&bible, "default_style")
            } else {
                style.trim()
            };
            let shot_size = inp_str("shot_size");
            let camera = inp_str("camera");
            let shot_text = grammar
                .pointer("/shot_sizes")
                .and_then(|m| m.get(&shot_size))
                .and_then(|v| v.as_str())
                .unwrap_or(&shot_size);
            let camera_text = grammar
                .pointer("/cameras")
                .and_then(|m| m.get(&camera))
                .and_then(|v| v.as_str())
                .unwrap_or(&camera);
            let emotion = inp_str("emotion");
            let cast_anchor = inp_str("cast_anchor");
            let override_p = inp_str("prompt_override");
            let scene = if !override_p.trim().is_empty() {
                override_p.trim().to_string()
            } else {
                let location = inp_str("location");
                let action = inp_str("action");
                let emotion_part = if emotion.trim().is_empty() {
                    String::new()
                } else {
                    format!("情绪：{}", emotion.trim())
                };
                join_prompt(&[location.trim(), action.trim(), &emotion_part])
            };
            let cast_text = if !cast_anchor.trim().is_empty() {
                format!("出场角色（严格按锚点）：{}", cast_anchor.trim())
            } else {
                String::new()
            };
            let c1 = img(upstream(id, "character1", 0, nodes, produced));
            let c2 = img(upstream(id, "character2", 0, nodes, produced));
            let c3 = img(upstream(id, "character3", 0, nodes, produced));
            let prev = img(upstream(id, "previous_frame", 0, nodes, produced));
            let mut parts = vec![
                style_prefix.to_string(),
                format!("{shot_text}，{camera_text}"),
                scene,
                cast_text,
            ];
            if !cast_anchor.trim().is_empty() {
                parts.push(str_of(&bible, "continuity").to_string());
            }
            if prev.is_some() {
                parts.push("与最后一帧参考图的场景、光线自然衔接".to_string());
            }
            parts.push(str_of(&bible, "frame_suffix").to_string());
            let parts_ref: Vec<&str> = parts.iter().map(|s| s.as_str()).collect();
            let prompt = join_prompt(&parts_ref);
            let neg_user = inp_str("negative");
            let neg = join_prompt(&[neg_default, str_of(&negative, "frame"), neg_user.trim()]);
            let mut refs = Vec::new();
            for c in [c1, c2, c3] {
                if let Some(i) = c {
                    refs.push(i);
                }
            }
            if let Some(p) = prev {
                refs.push(p);
            }
            let image = ark_image(
                ctx,
                &prompt,
                &inp_str("model"),
                &inp_str("size"),
                &refs,
                &neg,
                inp_bool("watermark"),
            )
            .await?;
            let url = image.source_url.clone();
            Ok(vec![NodeVal::Image(Arc::new(image)), NodeVal::Str(url)])
        }

        "DramaShotVideo" => {
            let first_frame = img(upstream(id, "first_frame", 0, nodes, produced))
                .ok_or("镜头视频缺少 first_frame 输入")?;
            let last_frame = img(upstream(id, "last_frame", 0, nodes, produced));
            let first_url = as_string(upstream(id, "first_frame_url", 1, nodes, produced));
            let last_url = as_string(upstream(id, "last_frame_url", 1, nodes, produced));
            let c1u = as_string(upstream(id, "character1_url", 1, nodes, produced));
            let c2u = as_string(upstream(id, "character2_url", 1, nodes, produced));
            let c3u = as_string(upstream(id, "character3_url", 1, nodes, produced));
            let camera = inp_str("camera");
            let camera_text = grammar
                .pointer("/cameras")
                .and_then(|m| m.get(&camera))
                .and_then(|v| v.as_str())
                .unwrap_or(&camera);
            let action = inp_str("action");
            let emotion = inp_str("emotion");
            let dialogue = inp_str("dialogue");
            let override_p = inp_str("prompt_override");
            let common = [
                format!("运镜：{camera_text}"),
                action.trim().to_string(),
                if emotion.trim().is_empty() {
                    String::new()
                } else {
                    format!("情绪：{}", emotion.trim())
                },
                if dialogue.trim().is_empty() {
                    String::new()
                } else {
                    format!("角色对镜头说：「{}」", dialogue.trim())
                },
                "画面无文字无水印".to_string(),
            ];
            let prompt = if !override_p.trim().is_empty() {
                override_p.trim().to_string()
            } else {
                let mut parts = common.to_vec();
                parts.push("保持首帧人物的五官、发型、服装、场景与光线一致，动作自然连贯".to_string());
                let refs: Vec<&str> = parts.iter().map(|s| s.as_str()).collect();
                join_prompt(&refs)
            };
            let refs: Vec<String> = [c1u, c2u, c3u]
                .into_iter()
                .map(|u| u.trim().to_string())
                .filter(|u| !u.is_empty())
                .collect();
            let ref_prompt = if !refs.is_empty() {
                let refs_text = refs
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("【图片{}】", i + 1))
                    .collect::<Vec<_>>()
                    .join("、");
                let location = inp_str("location");
                let cast_hint = inp_str("cast_hint");
                let mut parts = vec![
                    "全模态参考生视频，竖屏 9:16 电影短剧".to_string(),
                    format!("以{refs_text}中的人物为视频里对应的角色，严格参考图中人物的五官、发型、服装"),
                ];
                if !cast_hint.trim().is_empty() {
                    parts.push(format!("素材对应：{}", cast_hint.trim()));
                }
                if !location.trim().is_empty() {
                    parts.push(format!("场景：{}", location.trim()));
                }
                parts.extend(common.iter().cloned());
                let r: Vec<&str> = parts.iter().map(|s| s.as_str()).collect();
                join_prompt(&r)
            } else {
                prompt.clone()
            };
            let val = ark_video(
                ctx,
                id,
                &prompt,
                &inp_str("model"),
                Some(&first_frame),
                last_frame.as_ref(),
                &first_url,
                &last_url,
                def.inputs.get("duration").and_then(|v| v.as_i64()).unwrap_or(5),
                "adaptive",
                &inp_str("resolution"),
                inp_bool("generate_audio"),
                inp_bool("watermark"),
                &refs,
                &ref_prompt,
            )
            .await?;
            Ok(vec![NodeVal::Video(Arc::new(val))])
        }

        "StoryForgeSeedream" => {
            let refs: Vec<ImageVal> = ["character1", "character2", "character3"]
                .iter()
                .filter_map(|k| img(upstream(id, k, 0, nodes, produced)))
                .collect();
            let image = ark_image(
                ctx,
                &inp_str("prompt"),
                &inp_str("model"),
                &inp_str("size"),
                &refs,
                &inp_str("negative"),
                inp_bool("watermark"),
            )
            .await?;
            Ok(vec![NodeVal::Image(Arc::new(image))])
        }

        "StoryForgeSeedance" => {
            let first = img(upstream(id, "first_frame", 0, nodes, produced));
            let last = img(upstream(id, "last_frame", 0, nodes, produced));
            let first_url = as_string(upstream(id, "first_frame_url", 1, nodes, produced));
            let last_url = as_string(upstream(id, "last_frame_url", 1, nodes, produced));
            let val = ark_video(
                ctx,
                id,
                &inp_str("prompt"),
                &inp_str("model"),
                first.as_ref(),
                last.as_ref(),
                &first_url,
                &last_url,
                def.inputs.get("duration").and_then(|v| v.as_i64()).unwrap_or(5),
                &inp_str("ratio"),
                &inp_str("resolution"),
                inp_bool("generate_audio"),
                inp_bool("watermark"),
                &[],
                "",
            )
            .await?;
            Ok(vec![NodeVal::Video(Arc::new(val))])
        }

        /* ---------------- 像素杂活：ffmpeg ---------------- */
        "DramaContinuity" => {
            let v = video(upstream(id, "video", 0, nodes, produced))
                .ok_or("尾帧接续缺少 video 输入")?;
            let img = ffmpeg_last_frame(ctx, &v.path)?;
            Ok(vec![NodeVal::Image(Arc::new(img))])
        }

        "EmptyImage" => {
            let color = def.inputs.get("color").and_then(|v| v.as_i64()).unwrap_or(0x1b2430);
            let w = def.inputs.get("width").and_then(|v| v.as_i64()).unwrap_or(512).max(1);
            let h = def.inputs.get("height").and_then(|v| v.as_i64()).unwrap_or(512).max(1);
            let img = ffmpeg_empty_image(ctx, color, w, h)?;
            Ok(vec![NodeVal::Image(Arc::new(img))])
        }

        "ImageScale" => {
            let img = img(upstream(id, "image", 0, nodes, produced))
                .ok_or("缩放节点缺少 image 输入")?;
            let w = def.inputs.get("width").and_then(|v| v.as_i64()).unwrap_or(512).max(1);
            let h = def.inputs.get("height").and_then(|v| v.as_i64()).unwrap_or(512).max(1);
            let out = ffmpeg_scale(
                ctx,
                &img,
                &inp_str("upscale_method"),
                w,
                h,
                &inp_str("crop"),
            )?;
            Ok(vec![NodeVal::Image(Arc::new(out))])
        }

        "LoadImage" => {
            // 输入文件放在 workspace/input/ 下，inputs.image 是文件名
            let name = inp_str("image");
            if name.trim().is_empty() {
                return Err("加载图片缺少文件名".into());
            }
            let path = ctx.tmp_dir // input 目录由 lib.rs 传进 out_dir 的兄弟目录，见 kernel_submit
                .parent()
                .map(|p| p.join("input").join(&name))
                .unwrap_or_else(|| PathBuf::from(&name));
            let bytes = std::fs::read(&path).map_err(|_| {
                format!(
                    "找不到输入图片：{}（请把文件放进工作区的 input 文件夹）",
                    path.display()
                )
            })?;
            let mime = match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
                "jpg" | "jpeg" => "image/jpeg",
                "webp" => "image/webp",
                _ => "image/png",
            };
            Ok(vec![NodeVal::Image(Arc::new(ImageVal { bytes, mime: mime.into(), source_url: String::new() }))])
        }

        "LoadVideo" => {
            let name = inp_str("video");
            if name.trim().is_empty() {
                return Err("加载视频缺少文件名".into());
            }
            let path = ctx
                .tmp_dir
                .parent()
                .map(|p| p.join("input").join(&name))
                .unwrap_or_else(|| PathBuf::from(&name));
            if !path.exists() {
                return Err(format!(
                    "找不到输入视频：{}（请把文件放进工作区的 input 文件夹）",
                    path.display()
                ));
            }
            let duration = ffprobe_duration(&ctx.ffprobe, &path);
            Ok(vec![NodeVal::Video(Arc::new(VideoVal { path, duration }))])
        }

        /* ---------------- 落盘：Save* ---------------- */
        "SaveImage" | "SaveVideo" => {
            let is_video = def.class_type == "SaveVideo";
            let prefix = {
                let p = inp_str("filename_prefix");
                if p.trim().is_empty() {
                    "storyforge/output".to_string()
                } else {
                    p
                }
            };
            let norm = prefix.replace('\\', "/");
            let (sub, base) = match norm.rsplit_once('/') {
                Some((s, b)) => (s.to_string(), b.to_string()),
                None => (String::new(), norm.clone()),
            };
            let dir = if sub.is_empty() {
                ctx.out_dir.clone()
            } else {
                ctx.out_dir.join(&sub)
            };
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建输出目录失败：{e}"))?;

            if is_video {
                let v = video(upstream(id, "video", 0, nodes, produced))
                    .ok_or("保存视频缺少 video 输入")?;
                let filename = format!("{}_{:05}_.mp4", base, next_counter(&dir, &base, "mp4"));
                let dest = dir.join(&filename);
                std::fs::copy(&v.path, &dest).map_err(|e| format!("落盘视频失败：{e}"))?;
                let duration = v
                    .duration
                    .or_else(|| ffprobe_duration(&ctx.ffprobe, &dest))
                    .unwrap_or(0.0);
                ctx.record_output(
                    id,
                    "videos",
                    json!({
                        "filename": filename,
                        "subfolder": sub,
                        "type": "output",
                        "metadata": { "kind": "video", "duration": duration }
                    }),
                );
                Ok(vec![])
            } else {
                let mut vals = Vec::new();
                for key in ["images", "frame", "image"] {
                    if let Some(i) = img(upstream(id, key, 0, nodes, produced)) {
                        vals.push(i);
                        break;
                    }
                }
                if vals.is_empty() {
                    return Err("保存图片缺少 images 输入".into());
                }
                let mut files = Vec::new();
                for i in vals {
                    *assets_counter += 1;
                    let filename = format!(
                        "{}_{:05}_.png",
                        base,
                        next_counter(&dir, &base, "png")
                    );
                    let dest = dir.join(&filename);
                    std::fs::write(&dest, &i.bytes).map_err(|e| format!("落盘图片失败：{e}"))?;
                    files.push(json!({
                        "filename": filename,
                        "subfolder": sub,
                        "type": "output"
                    }));
                }
                for f in files {
                    ctx.record_output(id, "images", f);
                }
                Ok(vec![])
            }
        }

        other => Err(format!("内核不认识节点 {other}")),
    }
}

/// ComfyUI 同款计数器：目录里已有 {base}_00001_.png 就从下一个数起
fn next_counter(dir: &Path, base: &str, ext: &str) -> u32 {
    let mut max = 0u32;
    if let Ok(entries) = std::fs::read_dir(dir) {
        let prefix = format!("{base}_");
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let suffix = format!("_.{ext}");
            if let Some(rest) = name.strip_prefix(&prefix).and_then(|r| r.strip_suffix(&suffix)) {
                if let Ok(n) = rest.parse::<u32>() {
                    max = max.max(n);
                }
            }
        }
    }
    max + 1
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 提交一张图给内核执行。校验通过立刻返回 prompt_id，执行在后台异步进行，
/// 进度走 `kernel://event`，结果查 kernel_history。
#[tauri::command]
pub fn kernel_submit(
    app: AppHandle,
    graph: Value,
    client_id: String,
    out_dir: String,
    prompts_dir: String,
    ark_key: String,
    ffmpeg: String,
    ffprobe: String,
) -> Result<Value, String> {
    let nodes = parse_graph(&graph)?;
    let order = topo_order(&nodes)?;

    let prompt_id = new_prompt_id();
    let run = Arc::new(RunInfo::new());
    runs().lock().unwrap().insert(prompt_id.clone(), run.clone());

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;

    let ctx = Arc::new(RunCtx {
        client_id: client_id.clone(),
        prompt_id: prompt_id.clone(),
        run: run.clone(),
        key: ark_key,
        out_dir: PathBuf::from(&out_dir),
        tmp_dir: PathBuf::from(&out_dir)
            .parent()
            .map(|p| p.join("temp"))
            .unwrap_or_else(|| PathBuf::from(&out_dir).join("../temp")),
        prompts_dir: PathBuf::from(&prompts_dir),
        ffmpeg: PathBuf::from(&ffmpeg),
        ffprobe: PathBuf::from(&ffprobe),
        http,
        app: app.clone(),
    });

    let pid = prompt_id.clone();
    tauri::async_runtime::spawn(async move {
        let _ = std::fs::create_dir_all(&ctx.out_dir);
        let _ = std::fs::create_dir_all(&ctx.tmp_dir);
        ctx.emit(json!({ "type": "execution_start" }));
        let mut produced: HashMap<String, Vec<NodeVal>> = HashMap::new();
        let mut assets_counter: u64 = 0;
        let result: Result<(), String> = async {
            for nid in &order {
                ctx.check_cancel()?;
                ctx.emit_node("executing", nid);
                let outs = execute_node(&ctx, nid, &nodes, &mut produced, &mut assets_counter)
                    .await
                    .map_err(|e| {
                        if e == "__cancelled__" {
                            "已取消".to_string()
                        } else {
                            format!("节点 {nid} 执行失败：{e}")
                        }
                    })?;
                produced.insert(nid.clone(), outs);
                ctx.emit_node("executed", nid);
            }
            Ok(())
        }
        .await;

        match result {
            Ok(()) => {
                *ctx.run.status.lock().unwrap() = "success".into();
                ctx.emit(json!({ "type": "execution_success" }));
            }
            Err(e) => {
                let cancelled = e == "已取消" || ctx.run.cancelled();
                *ctx.run.status.lock().unwrap() = "error".into();
                *ctx.run.error.lock().unwrap() = e.clone();
                ctx.emit(json!({
                    "type": "execution_error",
                    "message": e,
                    "cancelled": cancelled,
                }));
            }
        }
        let _ = pid;
    });

    Ok(json!({ "prompt_id": prompt_id }))
}

/// 形状对齐 ComfyUI 的 GET /history/{prompt_id}
#[tauri::command]
pub fn kernel_history(prompt_id: String) -> Value {
    let run = runs().lock().unwrap().get(&prompt_id).cloned();
    match run {
        None => json!({}),
        Some(r) => {
            let status_str = r.status.lock().unwrap().clone();
            let completed = status_str != "running";
            let mut entry = Map::new();
            entry.insert(
                "status".into(),
                json!({
                    "status_str": if status_str == "error" { "error" } else { "success" },
                    "completed": completed,
                    "messages": [],
                }),
            );
            entry.insert("outputs".into(), r.outputs.lock().unwrap().clone());
            let err = r.error.lock().unwrap().clone();
            if !err.is_empty() {
                entry.insert("error".into(), json!(err));
            }
            let mut root = Map::new();
            root.insert(prompt_id, Value::Object(entry));
            Value::Object(root)
        }
    }
}

/// 掐掉当前在跑的执行（对齐 ComfyUI 的 POST /interrupt）
#[tauri::command]
pub fn kernel_interrupt() -> Result<Value, String> {
    for r in runs().lock().unwrap().values() {
        r.cancel.store(true, Ordering::Relaxed);
    }
    Ok(json!({ "ok": true }))
}

/// 找随包分发的 ffmpeg / ffprobe：
/// 调用方给的候选目录（exe 同目录 / 资源目录）→ 项目根 bin → PATH。
pub fn find_tool(candidates: &[PathBuf], root: &Path, name: &str) -> Option<PathBuf> {
    let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let mut dirs: Vec<PathBuf> = candidates.to_vec();
    dirs.push(root.join("bin"));
    dirs.push(root.join("app").join("bin"));
    dirs.push(root.join("engine").join("bin"));
    for d in dirs {
        let p = d.join(&file);
        if p.is_file() {
            return Some(p);
        }
    }
    // PATH 兜底
    if let Ok(path_var) = std::env::var("PATH") {
        for d in std::env::split_paths(&path_var) {
            let p = d.join(&file);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}
