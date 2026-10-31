//! StoryForge 原生内核：替代 ComfyUI 的本地执行器。
//!
//! 画布永远是 ComfyUI API 格式的图（"画布是唯一真相"），内核只做三件事：
//!   1. 拓扑执行图里的节点（只认 StoryForge 自家的 12 个节点，其余一律拒绝）；
//!   2. 需要生成力的节点直连火山 ARK（文生图 / 图生视频，逻辑对齐原 nodes.py）；
//!   3. 像素级杂活（占位图、缩放、抽尾帧）交给随包分发的 ffmpeg；
//!   4. 生成产物自审（全黑/全白/时长/分辨率/音轨），不合格自动重跑该镜（最多 2 轮）。
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
    /// P0-2 成本对账：估算（一次成功）在提交时定死；实际含自动重跑，逐次累加
    cost_est: f64,
    cost_actual: Mutex<f64>,
    budget_limit: f64,
    budget_mode: String,
}

impl RunInfo {
    fn new(cost_est: f64, budget_limit: f64, budget_mode: String) -> Self {
        Self {
            cancel: AtomicBool::new(false),
            status: Mutex::new("running".into()),
            outputs: Mutex::new(json!({})),
            error: Mutex::new(String::new()),
            cost_est,
            cost_actual: Mutex::new(0.0),
            budget_limit,
            budget_mode,
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
    /// 这条视频是哪家供应商生成的（P1-2 成本对账按家记账；本地素材 = "local"）
    provider: String,
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

/// 视频提示词拼装（纯函数，可单测）。
/// 吸收 Seedance 官方提示法（OpenMontage seedance-prompting skill）：
///   - 台词用引用句式（口型以引号内字符串为准，别用叙述式"对镜头说"）；
///   - generate_audio 时给一句贴合场景的声音方向（同步音频是 Seedance 的强项，
///     但不给方向模型就会瞎配环境声）；
///   - 运镜 / 动作 / 情绪各自成段，一句一拍。
fn shot_video_prompt_parts(
    camera_text: &str,
    action: &str,
    emotion: &str,
    dialogue: &str,
    location: &str,
    generate_audio: bool,
) -> Vec<String> {
    let mut parts = vec![
        format!("运镜：{camera_text}"),
        action.trim().to_string(),
    ];
    if !emotion.trim().is_empty() {
        parts.push(format!("情绪：{}", emotion.trim()));
    }
    if !dialogue.trim().is_empty() {
        parts.push(format!(
            "角色开口说（口型对准引号内台词）：「{}」",
            dialogue.trim()
        ));
    }
    if generate_audio {
        if location.trim().is_empty() {
            parts.push("声音：与画面同源的现场环境声与动作音效".to_string());
        } else {
            parts.push(format!(
                "声音：{} 的现场环境声，动作音效与画面同步",
                location.trim()
            ));
        }
    }
    parts.push("画面无文字无水印".to_string());
    parts
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
    /// P1-2：视频 Provider 选择（ark / jimeng）与即梦凭据
    video_provider: String,
    jimeng_ak: String,
    jimeng_sk: String,
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

    /// P0-1：自审结果写进历史。挂在生成节点名下的 "verification" 字段，
    /// 前端只读 images/videos 数组所以形状不受影响，资产页 / 历史面板可查。
    fn record_verification(&self, node: &str, audit: &Audit, attempt: u32) {
        let mut outputs = self.run.outputs.lock().unwrap();
        let entry = outputs
            .as_object_mut()
            .unwrap()
            .entry(node.to_string())
            .or_insert_with(|| json!({}));
        entry.as_object_mut().unwrap().insert(
            "verification".into(),
            json!({
                "ok": audit.ok,
                "attempt": attempt,
                "failed": audit.failed,
                "notes": audit.notes,
                "details": audit.details,
            }),
        );
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
    Ok(VideoVal { path, duration: None, provider: "ark".into() })
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

/// P2 多平台导出：按目标比例对成片做居中裁切（ffmpeg，crf 18 重编码，音轨直拷）。
/// 9:16 竖屏 → 16:9 横版（全宽裁高）；16:9 → 9:16 反向。已经是目标比例就拒绝空转。
pub fn export_aspect(
    ffmpeg: &Path,
    ffprobe: &Path,
    input: &str,
    aspect: &str,
    out_path: &str,
) -> Result<(), String> {
    // 先看源片比例：目标 ≈ 现状就别浪费一轮编码
    if let Some((w, h)) = ffprobe_streams(ffprobe, Path::new(input))
        .and_then(|(w, h, _, _)| w.zip(h))
        .filter(|(w, h)| *w > 0 && *h > 0)
    {
        let src_ratio = w as f64 / h as f64;
        let target_ratio = match aspect {
            "16:9" => 16.0 / 9.0,
            "9:16" => 9.0 / 16.0,
            _ => return Err(format!("不支持的比例 {aspect}（目前 16:9 / 9:16）")),
        };
        if (src_ratio - target_ratio).abs() / target_ratio < 0.05 {
            return Err(format!("这个片子已经是 {aspect} 左右的比例，不用再导"));
        }
    }
    // 居中裁切：宽高都取偶（libx264 yuv420p 要求）；高/宽按目标比例从源边推算
    let vf = match aspect {
        "16:9" => "crop=trunc(iw/2)*2:trunc(iw*9/16/2)*2",
        "9:16" => "crop=trunc(ih*9/16/2)*2:trunc(ih/2)*2",
        _ => return Err(format!("不支持的比例 {aspect}")),
    };
    run_ffmpeg(
        ffmpeg,
        &[
            "-y", "-i", input,
            "-vf", vf,
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p", "-c:a", "copy",
            out_path,
        ],
    )
}

// ---------------------------------------------------------------------------
// P0-1 产物自审：生成节点出产物后立即质检，不合格自动重跑（最多 2 轮，
// 学 OpenMontage reviewer 协议的"revise 最多 2 轮后 pass with warnings"，防无限烧钱）
// ---------------------------------------------------------------------------

/// 参与自审的节点 = 全部 ARK 生成节点。本地 ffmpeg 节点的输出是确定性的，不用查。
const AUDIT_GEN_NODES: &[&str] = &[
    "DramaCharacter",
    "DramaShotFrame",
    "StoryForgeSeedream",
    "DramaShotVideo",
    "StoryForgeSeedance",
];

/// 自审不合格后的自动重跑轮数上限（不含首次生成）
const AUDIT_MAX_RETRY: u32 = 2;

/// 全黑判定阈值（signalstats YAVG，YUV limited range：纯黑=16，夜戏安全余量）
const DARK_LIMIT: f64 = 18.0;
/// 全白判定阈值（YUV limited range：纯白=235）
const BRIGHT_LIMIT: f64 = 232.0;
/// 视频实测时长与计划时长的允许偏差（秒）
const DURATION_TOLERANCE: f64 = 1.5;
/// 分辨率短边允许下探比例（Seedance ratio=adaptive 时可能微调）
const RESOLUTION_TOLERANCE: f64 = 0.85;

struct Audit {
    ok: bool,
    failed: Vec<String>,
    notes: Vec<String>,
    details: Value,
}

impl Audit {
    fn pass(notes: Vec<String>, details: Value) -> Self {
        Self { ok: true, failed: Vec::new(), notes, details }
    }
    fn fail(&self) -> String {
        self.failed.join("；")
    }
    fn summary(&self) -> String {
        if self.ok {
            if self.notes.is_empty() {
                "自审通过".into()
            } else {
                format!("自审通过：{}", self.notes.join("；"))
            }
        } else {
            format!("自审不合格：{}", self.fail())
        }
    }
}

/// 重跑决策（纯函数，可单测）：通过 → 收货；取消 → 收货；
/// 超过轮数上限 → 收货但播报警告；否则 → 重跑。
fn retry_decision(ok: bool, attempt: u32, cancelled: bool) -> u8 {
    if cancelled || ok {
        0 // Accept
    } else if attempt >= AUDIT_MAX_RETRY {
        2 // CapWarn
    } else {
        1 // Rerun
    }
}

/// PNG IHDR 里的宽高（生成图永远是 PNG；读不出来就跳过尺寸校验）
fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || bytes[0..8] != [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return None;
    }
    let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Some((w, h))
}

/// 从 ffmpeg 输出文本里取最后一次出现的 YAVG（signalstats 平均亮度，0-255）
fn parse_yavg(text: &str) -> Option<f64> {
    let mut yavg = None;
    for part in text.split("YAVG=") {
        let num: String = part
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
            .collect();
        if let Ok(v) = num.parse::<f64>() {
            yavg = Some(v);
        }
    }
    yavg
}

/// 用 signalstats 算一帧的平均亮度。seek: None=首帧，Some(t)=定位到 t 秒。
fn frame_brightness(ffmpeg: &Path, src: &str, seek: Option<&str>) -> Option<f64> {
    let mut args: Vec<&str> = vec!["-y", "-hide_banner"];
    if let Some(t) = seek {
        args.push("-ss");
        args.push(t);
    }
    args.extend([
        "-i", src, "-frames:v", "1",
        "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG",
        "-f", "null", "-",
    ]);
    let mut cmd = std::process::Command::new(ffmpeg);
    cmd.args(&args);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().ok()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    parse_yavg(&text)
}

/// 视频流信息：宽 / 高 / fps / 是否有音轨
fn ffprobe_streams(ffprobe: &Path, file: &Path) -> Option<(Option<u32>, Option<u32>, Option<f64>, bool)> {
    let mut cmd = std::process::Command::new(ffprobe);
    cmd.args([
        "-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate",
        "-of", "json",
        file.to_str()?,
    ]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v: Value = serde_json::from_str(&String::from_utf8_lossy(&out.stdout)).ok()?;
    let streams = v.get("streams")?.as_array()?;
    let (mut w, mut h, mut fps, mut audio) = (None, None, None, false);
    for s in streams {
        match s.get("codec_type").and_then(|x| x.as_str()).unwrap_or("") {
            "video" => {
                w = s.get("width").and_then(|x| x.as_u64()).map(|x| x as u32).or(w);
                h = s.get("height").and_then(|x| x.as_u64()).map(|x| x as u32).or(h);
                if fps.is_none() {
                    if let Some(r) = s.get("avg_frame_rate").and_then(|x| x.as_str()) {
                        let mut it = r.split('/');
                        let a: f64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0.0);
                        let b: f64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(1.0);
                        if a > 0.0 && b > 0.0 {
                            fps = Some(a / b);
                        }
                    }
                }
            }
            "audio" => audio = true,
            _ => {}
        }
    }
    Some((w, h, fps, audio))
}

/// 图片自审：全黑/全白判废（亮度采样）+ 尺寸 vs size 参数
fn audit_image(ffmpeg: &Path, tmp_dir: &Path, img: &ImageVal, size_param: &str) -> Audit {
    let mut failed = Vec::new();
    let mut notes = Vec::new();
    let mut details = json!({ "bytes": img.bytes.len() });
    let tmp = tmp_dir.join(format!("audit_{}.png", new_prompt_id()));
    let _ = std::fs::create_dir_all(tmp_dir);
    if std::fs::write(&tmp, &img.bytes).is_err() {
        return Audit::pass(vec!["自检临时文件写失败，跳过质检".into()], details);
    }
    let bright = frame_brightness(ffmpeg, tmp.to_str().unwrap_or(""), None);
    let _ = std::fs::remove_file(&tmp);
    details["brightness"] = json!(bright);
    match bright {
        Some(b) if b < DARK_LIMIT => failed.push(format!("画面全黑（平均亮度 {b:.1}/255）")),
        Some(b) if b > BRIGHT_LIMIT => failed.push(format!("画面全白（平均亮度 {b:.1}/255）")),
        Some(b) => notes.push(format!("亮度 {b:.0}/255")),
        None => notes.push("亮度检测失败，已跳过".into()),
    }
    if let Some((w, h)) = png_size(&img.bytes) {
        details["width"] = json!(w);
        details["height"] = json!(h);
        let expect: Vec<u32> = size_param
            .split(['x', 'X', '*'])
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        if expect.len() == 2 && (expect[0] != w || expect[1] != h) {
            failed.push(format!("尺寸 {w}x{h} 与参数 {size_param} 不符"));
        } else if expect.len() == 2 {
            notes.push(format!("尺寸 {w}x{h} ✓"));
        }
    } else {
        notes.push("无法读取图片尺寸，已跳过尺寸校验".into());
    }
    Audit { ok: failed.is_empty(), failed, notes, details }
}

/// 视频自审：实测时长 vs 计划（±1.5s）+ 分辨率短边 + 音轨 + 首/中/尾三帧亮度判全黑全白
fn audit_video(
    ffmpeg: &Path,
    ffprobe: &Path,
    path: &Path,
    planned: Option<i64>,
    generate_audio: bool,
    resolution: &str,
) -> Audit {
    let mut failed = Vec::new();
    let mut notes = Vec::new();
    if !path.exists() {
        return Audit { ok: false, failed: vec!["视频文件不存在".into()], notes, details: json!({}) };
    }
    let src = path.to_str().unwrap_or("");
    let mut details = json!({ "planned_duration": planned, "generate_audio": generate_audio });
    if let Ok(meta) = std::fs::metadata(path) {
        details["file_size"] = json!(meta.len());
    }

    // 时长
    let dur = ffprobe_duration(ffprobe, path);
    match dur {
        Some(d) => {
            details["duration"] = json!(d);
            if let Some(p) = planned.filter(|p| *p > 0) {
                let diff = (d - p as f64).abs();
                if diff > DURATION_TOLERANCE {
                    failed.push(format!("实测时长 {d:.1}s 与计划 {p}s 偏差 {diff:.1}s（>{DURATION_TOLERANCE}s）"));
                } else {
                    notes.push(format!("时长 {d:.1}s ✓"));
                }
            } else {
                notes.push(format!("时长 {d:.1}s（未设计划时长，不比对）"));
            }
        }
        None => failed.push("ffprobe 读不到时长，文件可能损坏".into()),
    }

    // 流信息：分辨率 / fps / 音轨
    match ffprobe_streams(ffprobe, path) {
        Some((w, h, fps, audio)) => {
            details["width"] = json!(w);
            details["height"] = json!(h);
            details["fps"] = json!(fps);
            details["has_audio"] = json!(audio);
            if generate_audio && !audio {
                failed.push("要求生成音频，但没有音轨".into());
            }
            if audio {
                notes.push("音轨 ✓".to_string());
            }
            let expected_short = match resolution.trim() {
                "480p" => 480.0,
                "720p" => 720.0,
                "1080p" => 1080.0,
                _ => 0.0,
            };
            if expected_short > 0.0 {
                if let (Some(w), Some(h)) = (w, h) {
                    let short = w.min(h) as f64;
                    if short < expected_short * RESOLUTION_TOLERANCE {
                        failed.push(format!(
                            "分辨率 {w}x{h} 达不到 {resolution}（短边 {short:.0} < {}）",
                            (expected_short * RESOLUTION_TOLERANCE) as u32
                        ));
                    } else {
                        notes.push(format!("分辨率 {w}x{h} ✓"));
                    }
                }
            }
        }
        None => failed.push("ffprobe 读不到流信息，文件可能损坏".into()),
    }

    // 首 / 中 / 尾三帧亮度采样，全黑全白判废
    if let Some(d) = dur.filter(|d| *d > 0.0) {
        let mut samples: Vec<Option<f64>> = vec![frame_brightness(ffmpeg, src, None)];
        samples.push(frame_brightness(ffmpeg, src, Some(&format!("{:.2}", d * 0.5))));
        samples.push(frame_brightness(ffmpeg, src, Some(&format!("{:.2}", (d - 0.6).max(0.0)))));
        let got: Vec<f64> = samples.iter().filter_map(|b| *b).collect();
        details["brightness_samples"] = json!(samples);
        if got.len() >= 2 {
            if got.iter().all(|b| *b < DARK_LIMIT) {
                failed.push(format!("画面全黑（{} 帧采样亮度均 <{DARK_LIMIT:.0}/255）", got.len()));
            } else if got.iter().all(|b| *b > BRIGHT_LIMIT) {
                failed.push(format!("画面全白（{} 帧采样亮度均 >{BRIGHT_LIMIT:.0}/255）", got.len()));
            } else {
                let disp: Vec<String> = got.iter().map(|b| format!("{b:.0}")).collect();
                notes.push(format!("亮度采样 {}/255", disp.join("/")));
            }
        } else {
            notes.push("亮度采样不足，已跳过全黑全白判定".into());
        }
    }

    Audit { ok: failed.is_empty(), failed, notes, details }
}

/// 对一个生成节点的产物做自审（按节点类型分发）
fn audit_node_outputs(
    ffmpeg: &Path,
    ffprobe: &Path,
    tmp_dir: &Path,
    def: &NodeDef,
    outs: &[NodeVal],
) -> Audit {
    match def.class_type.as_str() {
        "DramaCharacter" | "DramaShotFrame" | "StoryForgeSeedream" => {
            let size = def.inputs.get("size").and_then(|v| v.as_str()).unwrap_or("");
            for v in outs {
                if let NodeVal::Image(i) = v {
                    return audit_image(ffmpeg, tmp_dir, i, size);
                }
            }
            Audit::pass(vec!["没有图片产物，跳过质检".into()], json!({}))
        }
        "DramaShotVideo" | "StoryForgeSeedance" => {
            let planned = def.inputs.get("duration").and_then(|v| v.as_i64());
            let gen_audio = def.inputs.get("generate_audio").and_then(|v| v.as_bool()).unwrap_or(false);
            let res = def.inputs.get("resolution").and_then(|v| v.as_str()).unwrap_or("720p");
            for v in outs {
                if let NodeVal::Video(vid) = v {
                    return audit_video(ffmpeg, ffprobe, &vid.path, planned, gen_audio, res);
                }
            }
            Audit::pass(vec!["没有视频产物，跳过质检".into()], json!({}))
        }
        _ => Audit::pass(vec![], json!({})),
    }
}

// ---------------------------------------------------------------------------
// P0-2 成本估算：ARK 官方价（2026-10 官网查证），单镜单价 × 镜头数 × 重试缓冲。
// 价格来源：火山方舟模型价格页；Seedance token 公式折算成元/秒（官方示例价 720p 16:9
// 5s = ¥7.56 → ¥1.51/s；各宽高比像素面积基本一致，按分辨率取档）。
// ---------------------------------------------------------------------------

/// Seedream 输出图单价（元/张）：单图生成 ≤261 万像素档；超档翻倍
const SEEDREAM_PIXEL_TIER: u64 = 2_610_000;
const SEEDREAM_PRO_CNY: f64 = 0.30;
const SEEDREAM_PRO_HI_CNY: f64 = 0.60;
/// 每张输入参考图加收
const SEEDREAM_REF_CNY: f64 = 0.02;

/// Seedance 输出单价（元/秒，输入不含视频；480p/720p/1080p）
const SEEDANCE_CNY_PER_SEC: &[(&str, f64)] = &[("480p", 0.67), ("720p", 1.51), ("1080p", 3.74)];
/// duration=-1（自动时长）时的估算时长
const SEEDANCE_AUTO_DURATION_S: f64 = 15.0;
/// 重试缓冲（学 OpenMontage cost_tracker 的 1.3x）：估算区间 [一次成功, ×1.3]
pub const COST_RETRY_BUFFER: f64 = 1.3;

/// Seedream 单张成本（元）
fn image_unit_cost(model: &str, size: &str, ref_count: usize) -> f64 {
    let dims: Vec<u64> = size
        .split(['x', 'X', '*'])
        .filter_map(|s| s.trim().parse::<u64>().ok())
        .collect();
    let px = if dims.len() == 2 { dims[0].saturating_mul(dims[1]) } else { 0 };
    let base = if model.contains("5-0-flash") {
        0.12
    } else if model.contains("5-0-lite") {
        0.22
    } else if model.contains("4-5") {
        0.25
    } else if model.contains("4-0") {
        0.20
    } else if px > SEEDREAM_PIXEL_TIER {
        SEEDREAM_PRO_HI_CNY
    } else {
        SEEDREAM_PRO_CNY
    };
    base + SEEDREAM_REF_CNY * ref_count as f64
}

/// Seedance 单条视频成本（元）
fn video_unit_cost(model: &str, resolution: &str, duration: i64) -> f64 {
    let per_sec = SEEDANCE_CNY_PER_SEC
        .iter()
        .find(|(r, _)| *r == resolution.trim())
        .map(|(_, p)| *p)
        .unwrap_or(1.51);
    // fast / mini 档按 token 单价比例打折（37/46 与 23/46）
    let tier = if model.contains("fast") {
        0.8
    } else if model.contains("mini") {
        0.5
    } else {
        1.0
    };
    let secs = if duration <= 0 { SEEDANCE_AUTO_DURATION_S } else { duration as f64 };
    per_sec * tier * secs
}

/// 单节点成本（元）；本地 ffmpeg 节点 0 元
fn node_unit_cost(def: &NodeDef) -> f64 {
    let model = || {
        def.inputs
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let ref_count = |keys: &[&str]| -> usize {
        keys.iter()
            .filter(|k| def.inputs.get(**k).map(is_link).unwrap_or(false))
            .count()
    };
    match def.class_type.as_str() {
        "DramaCharacter" => {
            let size = def.inputs.get("size").and_then(|v| v.as_str()).unwrap_or("");
            image_unit_cost(&model(), size, 0)
        }
        "DramaShotFrame" => {
            let size = def.inputs.get("size").and_then(|v| v.as_str()).unwrap_or("");
            image_unit_cost(
                &model(),
                size,
                ref_count(&["character1", "character2", "character3", "previous_frame"]),
            )
        }
        "StoryForgeSeedream" => {
            let size = def.inputs.get("size").and_then(|v| v.as_str()).unwrap_or("");
            image_unit_cost(&model(), size, ref_count(&["character1", "character2", "character3"]))
        }
        "DramaShotVideo" | "StoryForgeSeedance" => {
            let resolution = def.inputs.get("resolution").and_then(|v| v.as_str()).unwrap_or("720p");
            let duration = def.inputs.get("duration").and_then(|v| v.as_i64()).unwrap_or(5);
            video_unit_cost(&model(), resolution, duration)
        }
        _ => 0.0,
    }
}

/// 整图估算（元，一次成功的理想值）；不可解析的图直接报错
pub fn estimate_graph_cost(graph: &Value, video_provider: &str) -> Result<f64, String> {
    let nodes = parse_graph(graph)?;
    Ok(nodes
        .values()
        .map(|def| node_unit_cost_routed(def, video_provider))
        .sum())
}

// ---------------------------------------------------------------------------
// P1-2 Provider 抽象：视频生成解锁 ARK 单点依赖。
// ArkProvider = 现有 Seedance 链路；JimengProvider = 火山 CV（即梦），
// IAM V4 签名（AK/SK），流程对齐 OpenMontage jimeng_video.py：
//   CVSync2AsyncSubmitTask → 5s 轮询 CVSync2AsyncGetResult → video_url。
// 节点按输入能力路由：即梦不支持的能力（尾帧/多图参考/音频）自动回落 ARK。
// ---------------------------------------------------------------------------

/// 即梦按条估算（元/条，占位：官方未公开按条刊例价，先按此计，确认门可见）
const JIMENG_CNY_PER_CLIP: f64 = 0.50;
const JIMENG_REQ_KEY: &str = "jimeng_ti2v_v30_pro";
const JIMENG_HOST: &str = "visual.volcengineapi.com";
const JIMENG_REGION: &str = "cn-north-1";
const JIMENG_SERVICE: &str = "cv";
const JIMENG_API_VERSION: &str = "2022-08-31";

/// 一条视频生成请求的完整参数（供应商无关）
#[allow(dead_code)]
struct VideoReq {
    node: String,
    prompt: String,
    model: String,
    first_frame: Option<ImageVal>,
    last_frame: Option<ImageVal>,
    first_frame_url: String,
    last_frame_url: String,
    duration: i64,
    ratio: String,
    resolution: String,
    generate_audio: bool,
    watermark: bool,
    reference_urls: Vec<String>,
    reference_prompt: String,
}

type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

// name/capabilities/estimate_cny 是 Provider 契约面：路由、计价与 UI 汇报共用，
// 当前生产路径只走 generate_video，其余留给多供应商扩展与测试
#[allow(dead_code)]
trait VideoProvider: Send + Sync {
    fn name(&self) -> &'static str;
    /// 支持的输入能力；节点要求超出能力时由路由回落 ARK
    fn capabilities(&self) -> &'static [&'static str];
    fn estimate_cny(&self, req: &VideoReq) -> f64;
    fn generate_video<'a>(
        &'a self,
        ctx: &'a RunCtx,
        req: &'a VideoReq,
    ) -> BoxFuture<'a, Result<VideoVal, String>>;
}

/// ARK（豆包 Seedance）：能力最全，基准实现
struct ArkProvider;

impl VideoProvider for ArkProvider {
    fn name(&self) -> &'static str {
        "ark"
    }
    fn capabilities(&self) -> &'static [&'static str] {
        &["first_frame", "last_frame", "reference", "audio"]
    }
    fn estimate_cny(&self, req: &VideoReq) -> f64 {
        video_unit_cost(&req.model, &req.resolution, req.duration)
    }
    fn generate_video<'a>(
        &'a self,
        ctx: &'a RunCtx,
        req: &'a VideoReq,
    ) -> BoxFuture<'a, Result<VideoVal, String>> {
        Box::pin(async move {
            ark_video(
                ctx,
                &req.node,
                &req.prompt,
                &req.model,
                req.first_frame.as_ref(),
                req.last_frame.as_ref(),
                &req.first_frame_url,
                &req.last_frame_url,
                req.duration,
                &req.ratio,
                &req.resolution,
                req.generate_audio,
                req.watermark,
                &req.reference_urls,
                &req.reference_prompt,
            )
            .await
        })
    }
}

/// 即梦（火山 CV）：只支持首帧图生视频，无音频
struct JimengProvider {
    ak: String,
    sk: String,
}

impl VideoProvider for JimengProvider {
    fn name(&self) -> &'static str {
        "jimeng"
    }
    fn capabilities(&self) -> &'static [&'static str] {
        &["first_frame"]
    }
    fn estimate_cny(&self, _req: &VideoReq) -> f64 {
        JIMENG_CNY_PER_CLIP
    }
    fn generate_video<'a>(
        &'a self,
        ctx: &'a RunCtx,
        req: &'a VideoReq,
    ) -> BoxFuture<'a, Result<VideoVal, String>> {
        Box::pin(async move { jimeng_generate(ctx, req, &self.ak, &self.sk).await })
    }
}

/// urllib.parse.quote(s, safe='') 同款百分号编码：只留 A-Za-z0-9 和 _.-
fn pct_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 火山 IAM V4 签名（移植 jimeng_video.py _sign，逐行对齐）。
/// x_date 由调用方传入（生产传当前 UTC，测试传固定值对拍）。
fn jimeng_sign(
    ak: &str,
    sk: &str,
    query: &[(&str, &str)],
    body: &[u8],
    x_date: &str,
) -> Vec<(String, String)> {
    use hmac::{Hmac, Mac};
    use sha2::{Digest, Sha256};
    type HmacSha256 = Hmac<Sha256>;

    fn sha256_hex(data: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(data);
        format!("{:x}", h.finalize())
    }
    fn hmac_hex(key: &[u8], data: &[u8]) -> Vec<u8> {
        let mut mac = HmacSha256::new_from_slice(key).expect("HMAC 接受任意长度 key");
        mac.update(data);
        mac.finalize().into_bytes().to_vec()
    }

    let short_date = &x_date[..8];
    let body_hash = sha256_hex(body);

    // 参与签名的头（小写、排序）：content-type / host / x-content-sha256 / x-date
    let lower: Vec<(String, String)> = vec![
        ("content-type".into(), "application/json".into()),
        ("host".into(), JIMENG_HOST.into()),
        ("x-content-sha256".into(), body_hash.clone()),
        ("x-date".into(), x_date.into()),
    ];
    let signed_str = lower
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers: String =
        lower.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();

    let mut q: Vec<(String, String)> = query
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    q.sort();
    let canonical_query = q
        .iter()
        .map(|(k, v)| format!("{}={}", pct_encode(k), pct_encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    let canonical_request = [
        "POST",
        "/",
        canonical_query.as_str(),
        canonical_headers.as_str(),
        signed_str.as_str(),
        body_hash.as_str(),
    ]
    .join("\n");

    let credential_scope = format!("{short_date}/{JIMENG_REGION}/{JIMENG_SERVICE}/request");
    let string_to_sign = [
        "HMAC-SHA256",
        x_date,
        credential_scope.as_str(),
        sha256_hex(canonical_request.as_bytes()).as_str(),
    ]
    .join("\n");

    let k_date = hmac_hex(sk.as_bytes(), short_date.as_bytes());
    let k_region = hmac_hex(&k_date, JIMENG_REGION.as_bytes());
    let k_service = hmac_hex(&k_region, JIMENG_SERVICE.as_bytes());
    let k_signing = hmac_hex(&k_service, b"request");
    let signature: Vec<u8> = {
        let mut mac = HmacSha256::new_from_slice(&k_signing).unwrap();
        mac.update(string_to_sign.as_bytes());
        mac.finalize().into_bytes().to_vec()
    };
    let sig_hex: String = signature.iter().map(|b| format!("{b:02x}")).collect();

    vec![
        ("Content-Type".into(), "application/json".into()),
        ("X-Date".into(), x_date.into()),
        ("X-Content-Sha256".into(), body_hash),
        (
            "Authorization".into(),
            format!(
                "HMAC-SHA256 Credential={ak}/{credential_scope}, SignedHeaders={signed_str}, Signature={sig_hex}"
            ),
        ),
    ]
}

/// 即梦请求体（纯函数，可单测）：duration→frames（>=10s→241，否则 121）
fn jimeng_payload(req: &VideoReq) -> Value {
    let dur = if req.duration <= 0 { 5 } else { req.duration };
    let frames = if dur >= 10 { 241 } else { 121 };
    let ratio = match req.ratio.trim() {
        "" | "adaptive" => "9:16",
        r => r,
    };
    let mut p = json!({
        "req_key": JIMENG_REQ_KEY,
        "prompt": req.prompt,
        "frames": frames,
        "aspect_ratio": ratio,
        "seed": -1,
    });
    let first = req
        .first_frame_url
        .trim()
        .non_empty()
        .map(|s| s.to_string())
        .or_else(|| req.first_frame.as_ref().map(|f| f.data_url()));
    if let Some(u) = first {
        p["image_urls"] = json!([u]);
    }
    p
}

/// 即梦签名请求（提交与轮询共用）：签 V4 头 → POST → 解析 JSON
async fn jimeng_post(
    http: &reqwest::Client,
    ak: &str,
    sk: &str,
    q: &[(&str, &str)],
    body: Vec<u8>,
) -> Result<Value, String> {
    let x_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let headers = jimeng_sign(ak, sk, q, &body, &x_date);
    let qs: Vec<String> = q
        .iter()
        .map(|(k, v)| format!("{}={}", pct_encode(k), pct_encode(v)))
        .collect();
    let rb = format!("https://{JIMENG_HOST}/?{}", qs.join("&"));
    let mut req = http.post(&rb);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    let resp = req
        .timeout(Duration::from_secs(60))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("即梦请求失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("即梦请求失败 HTTP {}", resp.status()));
    }
    resp.json::<Value>()
        .await
        .map_err(|e| format!("即梦响应解析失败：{e}"))
}

/// 即梦生视频：提交 → 5s 轮询 → 下载落盘
async fn jimeng_generate(
    ctx: &RunCtx,
    req: &VideoReq,
    ak: &str,
    sk: &str,
) -> Result<VideoVal, String> {
    let submit_query: [(&str, &str); 2] =
        [("Action", "CVSync2AsyncSubmitTask"), ("Version", JIMENG_API_VERSION)];
    let poll_query: [(&str, &str); 2] =
        [("Action", "CVSync2AsyncGetResult"), ("Version", JIMENG_API_VERSION)];
    let submit_body = jimeng_payload(req).to_string().into_bytes();

    let created = jimeng_post(&ctx.http, ak, sk, &submit_query, submit_body).await?;
    let task_id = match created.pointer("/data/task_id") {
        Some(Value::String(s)) => s.clone(),
        Some(v) if v.is_i64() || v.is_u64() => v.to_string(),
        _ => return Err(format!("即梦未返回 task_id: {}", truncate(&created.to_string(), 400))),
    };

    let poll_body = json!({
        "req_key": JIMENG_REQ_KEY,
        "task_id": task_id,
        "req_json": "{\"return_url\":true}",
    })
    .to_string()
    .into_bytes();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(25 * 60);
    let started = std::time::Instant::now();
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("即梦任务超时（task {task_id}）"));
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
        ctx.check_cancel()?;
        let info = jimeng_post(&ctx.http, ak, sk, &poll_query, poll_body.clone()).await?;
        let status = info.pointer("/data/status").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if !status.is_empty() {
            let secs = started.elapsed().as_secs();
            ctx.emit(json!({ "type": "progress", "node": req.node, "detail": format!("生成中 · {secs}s · {status} · 即梦") }));
        }
        if status == "done" {
            let video_url = info
                .pointer("/data/video_url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("即梦任务完成但没有视频地址: {}", truncate(&info.to_string(), 400)))?;
            let bytes = download(ctx, video_url).await?;
            std::fs::create_dir_all(&ctx.tmp_dir).map_err(|e| e.to_string())?;
            let path = ctx.tmp_dir.join(format!("jimeng_{}.mp4", new_prompt_id()));
            std::fs::write(&path, &bytes).map_err(|e| format!("落盘视频失败：{e}"))?;
            let duration = ffprobe_duration(&ctx.ffprobe, &path);
            return Ok(VideoVal { path, duration, provider: "jimeng".into() });
        }
        if matches!(status.as_str(), "not_found" | "expired") {
            return Err(format!("即梦任务无效（{status}）: {}", truncate(&info.to_string(), 400)));
        }
    }
}

/// 选中即梦时，这一镜能不能真用即梦（能力 + 凭据检查；纯逻辑可单测）
fn jimeng_can_serve(
    provider: &str,
    has_last_frame: bool,
    has_reference: bool,
    generate_audio: bool,
    ak_configured: bool,
) -> Result<(), String> {
    if provider != "jimeng" {
        return Ok(()); // 没选即梦，直接走 ARK
    }
    let mut missing: Vec<&str> = Vec::new();
    if has_last_frame {
        missing.push("尾帧");
    }
    if has_reference {
        missing.push("多图参考");
    }
    if generate_audio {
        missing.push("音频");
    }
    if !missing.is_empty() {
        return Err(format!("即梦不支持{}", missing.join("、")));
    }
    if !ak_configured {
        return Err("即梦 AK/SK 未配置".into());
    }
    Ok(())
}

/// 视频节点统一入口：按配置选 Provider，能力不够回落 ARK
async fn run_video_routed(ctx: &RunCtx, req: &VideoReq) -> Result<VideoVal, String> {
    let ak_ready = !ctx.jimeng_ak.trim().is_empty() && !ctx.jimeng_sk.trim().is_empty();
    if let Err(why) = jimeng_can_serve(
        &ctx.video_provider,
        req.last_frame.is_some() || !req.last_frame_url.trim().is_empty(),
        !req.reference_urls.is_empty(),
        req.generate_audio,
        ak_ready,
    ) {
        ctx.emit(json!({
            "type": "progress",
            "node": req.node,
            "detail": format!("{why}，本镜回落 ARK"),
        }));
        return ArkProvider.generate_video(ctx, req).await;
    }
    let provider = video_provider(&ctx.video_provider, &ctx.jimeng_ak, &ctx.jimeng_sk);
    provider.generate_video(ctx, req).await
}

fn video_provider(name: &str, jimeng_ak: &str, jimeng_sk: &str) -> Box<dyn VideoProvider> {
    if name == "jimeng" && !jimeng_ak.trim().is_empty() && !jimeng_sk.trim().is_empty() {
        Box::new(JimengProvider {
            ak: jimeng_ak.to_string(),
            sk: jimeng_sk.to_string(),
        })
    } else {
        Box::new(ArkProvider)
    }
}

/// 选中即梦且这镜兼容即梦时按条计价，否则按 ARK 表
fn node_unit_cost_routed(def: &NodeDef, video_provider: &str) -> f64 {
    match def.class_type.as_str() {
        "DramaShotVideo" | "StoryForgeSeedance" => {
            let has_last = is_link(def.inputs.get("last_frame").unwrap_or(&Value::Null));
            let has_ref = ["character1_url", "character2_url", "character3_url"]
                .iter()
                .any(|k| {
                    !def.inputs
                        .get(*k)
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .is_empty()
                });
            let audio = def.inputs.get("generate_audio").and_then(|v| v.as_bool()).unwrap_or(false);
            if video_provider == "jimeng" {
                jimeng_can_serve("jimeng", has_last, has_ref, audio, true)
                    .map(|_| JIMENG_CNY_PER_CLIP)
                    .unwrap_or_else(|_| node_unit_cost(def))
            } else {
                node_unit_cost(def)
            }
        }
        _ => node_unit_cost(def),
    }
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
            let common = shot_video_prompt_parts(
                &camera_text,
                &action,
                &emotion,
                &dialogue,
                &inp_str("location"),
                inp_bool("generate_audio"),
            );
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
            let req = VideoReq {
                node: id.to_string(),
                prompt,
                model: inp_str("model"),
                first_frame: Some(first_frame),
                last_frame,
                first_frame_url: first_url,
                last_frame_url: last_url,
                duration: def.inputs.get("duration").and_then(|v| v.as_i64()).unwrap_or(5),
                ratio: "adaptive".into(),
                resolution: inp_str("resolution"),
                generate_audio: inp_bool("generate_audio"),
                watermark: inp_bool("watermark"),
                reference_urls: refs,
                reference_prompt: ref_prompt,
            };
            let val = run_video_routed(ctx, &req).await?;
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
            let req = VideoReq {
                node: id.to_string(),
                prompt: inp_str("prompt"),
                model: inp_str("model"),
                first_frame: first,
                last_frame: last,
                first_frame_url: first_url,
                last_frame_url: last_url,
                duration: def.inputs.get("duration").and_then(|v| v.as_i64()).unwrap_or(5),
                ratio: inp_str("ratio"),
                resolution: inp_str("resolution"),
                generate_audio: inp_bool("generate_audio"),
                watermark: inp_bool("watermark"),
                reference_urls: vec![],
                reference_prompt: String::new(),
            };
            let val = run_video_routed(ctx, &req).await?;
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
            Ok(vec![NodeVal::Video(Arc::new(VideoVal { path, duration, provider: "local".into() }))])
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
#[allow(clippy::too_many_arguments)]
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
    budget_limit: f64,
    budget_mode: String,
    video_provider: String,
    jimeng_ak: String,
    jimeng_sk: String,
) -> Result<Value, String> {
    let nodes = parse_graph(&graph)?;
    let order = topo_order(&nodes)?;

    // P0-2 预算治理：cap 模式下估算（含重试缓冲）超限直接拒收，一个请求都不发
    let est = nodes
        .values()
        .map(|def| node_unit_cost_routed(def, &video_provider))
        .sum::<f64>();
    if budget_mode == "cap" && budget_limit > 0.0 && est * COST_RETRY_BUFFER > budget_limit {
        return Err(format!(
            "预算拦截（cap 模式）：预计 ¥{est:.2}、含重试缓冲至多 ¥{:.2}，超过单次上限 ¥{budget_limit:.2}。可到「设置 → 预算」调高上限，或改成提醒模式。",
            est * COST_RETRY_BUFFER
        ));
    }

    let prompt_id = new_prompt_id();
    let run = Arc::new(RunInfo::new(est, budget_limit, budget_mode.clone()));
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
        video_provider,
        jimeng_ak,
        jimeng_sk,
    });

    let pid = prompt_id.clone();
    tauri::async_runtime::spawn(async move {
        let _ = std::fs::create_dir_all(&ctx.out_dir);
        let _ = std::fs::create_dir_all(&ctx.tmp_dir);
        ctx.emit(json!({ "type": "execution_start" }));
        // P0-2 warn 模式：超限不拦，但开跑前明说
        if ctx.run.budget_mode == "warn"
            && ctx.run.budget_limit > 0.0
            && ctx.run.cost_est * COST_RETRY_BUFFER > ctx.run.budget_limit
        {
            ctx.emit(json!({
                "type": "progress",
                "detail": format!(
                    "预算提醒：预计 ¥{:.2}、含重试缓冲至多 ¥{:.2}，超过单次上限 ¥{:.2}（warn 模式只提醒不拦截）",
                    ctx.run.cost_est, ctx.run.cost_est * COST_RETRY_BUFFER, ctx.run.budget_limit
                ),
            }));
        }
        let mut produced: HashMap<String, Vec<NodeVal>> = HashMap::new();
        let mut assets_counter: u64 = 0;
        let result: Result<(), String> = async {
            for nid in &order {
                ctx.check_cancel()?;
                ctx.emit_node("executing", nid);
                let mut outs = execute_node(&ctx, nid, &nodes, &mut produced, &mut assets_counter)
                    .await
                    .map_err(|e| {
                        if e == "__cancelled__" {
                            "已取消".to_string()
                        } else {
                            format!("节点 {nid} 执行失败：{e}")
                        }
                    })?;
                // P0-1 自审：生成节点产物质检，不合格自动重跑该镜（复用单节点重跑，
                // 上游角色图不重新生成；最多 2 轮，之后 pass with warnings 不烧钱）
                if let Some(def) = nodes.get(nid) {
                    if AUDIT_GEN_NODES.contains(&def.class_type.as_str()) {
                        let mut attempt: u32 = 0;
                        loop {
                            // P0-2 对账：每跑一次（首跑 + 重跑）记一次钱，按实际用的 Provider 计价
                            let used_provider = outs
                                .iter()
                                .find_map(|v| match v {
                                    NodeVal::Video(vid) => Some(vid.provider.clone()),
                                    _ => None,
                                })
                                .unwrap_or_else(|| ctx.video_provider.clone());
                            *ctx.run.cost_actual.lock().unwrap() +=
                                node_unit_cost_routed(def, &used_provider);
                            let audit = audit_node_outputs(
                                &ctx.ffmpeg,
                                &ctx.ffprobe,
                                &ctx.tmp_dir,
                                def,
                                &outs,
                            );
                            ctx.record_verification(nid, &audit, attempt);
                            ctx.emit(json!({ "type": "progress", "node": nid, "detail": audit.summary() }));
                            match retry_decision(audit.ok, attempt, ctx.run.cancelled()) {
                                0 => break, // 通过 / 已取消
                                2 => {
                                    // 重试上限：按原样保留并明说
                                    ctx.emit(json!({
                                        "type": "progress", "node": nid,
                                        "detail": format!(
                                            "自审不合格已达重试上限（{AUDIT_MAX_RETRY} 轮），按原样保留：{}",
                                            audit.fail()
                                        ),
                                    }));
                                    break;
                                }
                                _ => {
                                    attempt += 1;
                                    ctx.emit(json!({
                                        "type": "progress", "node": nid,
                                        "detail": format!(
                                            "自审不合格（{}），自动重跑（第 {attempt}/{AUDIT_MAX_RETRY} 轮）",
                                            audit.fail()
                                        ),
                                    }));
                                    outs = execute_node(&ctx, nid, &nodes, &mut produced, &mut assets_counter)
                                        .await
                                        .map_err(|e| {
                                            if e == "__cancelled__" {
                                                "已取消".to_string()
                                            } else {
                                                format!("节点 {nid} 重跑失败：{e}")
                                            }
                                        })?;
                                }
                            }
                        }
                    }
                }
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
            // P0-2 成本对账：估算 / 含缓冲上限 / 实际（含自动重跑）/ 上限与模式
            entry.insert(
                "cost".into(),
                json!({
                    "estimated": (r.cost_est * 100.0).round() / 100.0,
                    "buffered": (r.cost_est * COST_RETRY_BUFFER * 100.0).round() / 100.0,
                    "actual": (*r.cost_actual.lock().unwrap() * 100.0).round() / 100.0,
                    "limit": r.budget_limit,
                    "mode": r.budget_mode,
                }),
            );
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

// ---------------------------------------------------------------------------
// 自审单测：黑屏视频 / 全白图必须判废，正常内容必须放行
//（依赖随包的 ffmpeg/ffprobe，只在本机构建时跑）
// ---------------------------------------------------------------------------

#[cfg(all(test, windows))]
mod audit_tests {
    use super::*;

    struct Tools {
        ffmpeg: PathBuf,
        ffprobe: PathBuf,
        tmp: PathBuf,
    }

    impl Tools {
        fn new() -> Self {
            static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            // 每个测试实例独立子目录：cargo test 并行跑，共用目录会被别人的 Drop 清掉
            let tmp = manifest.join("..").join("..").join(format!(".test-audit-tmp-{n}"));
            let _ = std::fs::create_dir_all(&tmp);
            Self {
                ffmpeg: manifest.join("..").join("bin").join("ffmpeg.exe"),
                ffprobe: manifest.join("..").join("bin").join("ffprobe.exe"),
                tmp,
            }
        }
        /// 用 lavfi 造测试素材（确定性输出，不花一分钱）
        fn make(&self, lavfi: &[&str], out: &str) -> PathBuf {
            let path = self.tmp.join(out);
            let mut args: Vec<&str> = vec!["-y"];
            args.extend_from_slice(lavfi);
            args.push(path.to_str().unwrap());
            run_ffmpeg(&self.ffmpeg, &args).expect("造测试素材失败");
            path
        }
    }

    impl Drop for Tools {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.tmp);
        }
    }

    #[test]
    fn black_video_is_rejected() {
        let t = Tools::new();
        let v = t.make(
            &["-f", "lavfi", "-i", "color=c=black:s=320x568:d=3", "-r", "24"],
            "black.mp4",
        );
        let a = audit_video(&t.ffmpeg, &t.ffprobe, &v, Some(5), false, "720p");
        assert!(!a.ok, "黑屏视频必须判废");
        assert!(a.failed.iter().any(|f| f.contains("全黑")), "应有全黑判定：{:?}", a.failed);
        assert!(
            a.failed.iter().any(|f| f.contains("时长")),
            "应有时长偏差判定（3s vs 计划 5s）：{:?}",
            a.failed
        );
    }

    #[test]
    fn white_image_is_rejected() {
        let t = Tools::new();
        let img_bytes = std::fs::read(t.make(
            &["-f", "lavfi", "-i", "color=c=white:s=100x100", "-frames:v", "1"],
            "white.png",
        ))
        .unwrap();
        let img = ImageVal { bytes: img_bytes, mime: "image/png".into(), source_url: String::new() };
        let a = audit_image(&t.ffmpeg, &t.tmp, &img, "1080x1920");
        assert!(!a.ok, "全白图必须判废");
        assert!(a.failed.iter().any(|f| f.contains("全白")), "{:?}", a.failed);
        assert!(
            a.failed.iter().any(|f| f.contains("尺寸")),
            "尺寸 100x100 vs 1080x1920 应判不符：{:?}",
            a.failed
        );
    }

    #[test]
    fn normal_artifacts_pass() {
        let t = Tools::new();
        // 灰色 1080x1920 图，尺寸与参数一致 → 放行
        let img_bytes = std::fs::read(t.make(
            &["-f", "lavfi", "-i", "color=c=0x808080:s=1080x1920", "-frames:v", "1"],
            "gray.png",
        ))
        .unwrap();
        assert_eq!(png_size(&img_bytes), Some((1080, 1920)), "PNG 尺寸解析");
        let img = ImageVal { bytes: img_bytes, mime: "image/png".into(), source_url: String::new() };
        let a = audit_image(&t.ffmpeg, &t.tmp, &img, "1080x1920");
        assert!(a.ok, "正常灰图应放行：{:?}", a.failed);

        // 中灰视频 + 时长对 + 分辨率对 → 放行（无音轨但没要求音频）
        let v = t.make(
            &["-f", "lavfi", "-i", "color=c=0x808080:s=720x1280:d=5", "-r", "24"],
            "gray.mp4",
        );
        let a = audit_video(&t.ffmpeg, &t.ffprobe, &v, Some(5), false, "720p");
        assert!(a.ok, "正常灰视频应放行：{:?}", a.failed);
    }

    #[test]
    fn missing_audio_and_low_resolution_are_rejected() {
        let t = Tools::new();
        // 无音轨 + 要求生成音频 → 判废；分辨率 320x180 远低于 720p → 判废
        let v = t.make(
            &["-f", "lavfi", "-i", "color=c=0x808080:s=320x180:d=5", "-r", "24"],
            "small.mp4",
        );
        let a = audit_video(&t.ffmpeg, &t.ffprobe, &v, Some(5), true, "720p");
        assert!(!a.ok);
        assert!(a.failed.iter().any(|f| f.contains("音轨")), "{:?}", a.failed);
        assert!(a.failed.iter().any(|f| f.contains("分辨率")), "{:?}", a.failed);
    }

    #[test]
    fn retry_decision_rules() {
        // 通过 / 取消 → 收货；连续失败（attempt 0,1,2）→ 2 轮后收货+警告
        assert_eq!(retry_decision(true, 0, false), 0);
        assert_eq!(retry_decision(false, 0, true), 0);
        assert_eq!(retry_decision(false, 0, false), 1);
        assert_eq!(retry_decision(false, 1, false), 1);
        assert_eq!(retry_decision(false, 2, false), 2, "第 3 次失败必须止损");
    }

    #[test]
    fn yavg_parse() {
        assert_eq!(parse_yavg("frame:0 pts:0\nlavfi.signalstats.YAVG=57.375000"), Some(57.375));
        assert_eq!(parse_yavg("no data here"), None);
        assert_eq!(parse_yavg("YAVG=0.0 later YAVG=12.5"), Some(12.5), "取最后一次");
    }

    #[test]
    fn shot_video_prompt_lipsync_and_audio() {
        // 台词走引用句式（唇形同步 key 引号内字符串），不再是叙述式"对镜头说"
        let parts = shot_video_prompt_parts(
            "镜头缓慢推近，逐渐收紧到人物",
            "她把伞收起，甩了甩雨水",
            "强忍泪水",
            "你到底想说什么",
            "雨夜便利店门口",
            true,
        );
        let joined = parts.join("；");
        assert!(
            parts.iter().any(|p| p.contains("口型对准引号内台词") && p.contains("「你到底想说什么」")),
            "台词必须引用句式：{joined}"
        );
        assert!(
            parts.iter().any(|p| p.contains("雨夜便利店门口") && p.contains("环境声")),
            "有 location 时声音方向要贴场景：{joined}"
        );
        assert!(parts.iter().any(|p| p.contains("画面无文字无水印")));

        // 无台词 + 不生成音频：不出现声音段
        let parts = shot_video_prompt_parts("固定机位", "她站着", "", "", "", false);
        assert!(!parts.iter().any(|p| p.contains("声音")));

        // 无 location 的兜底声音方向
        let parts = shot_video_prompt_parts("固定机位", "她站着", "", "", "", true);
        assert!(parts.iter().any(|p| p.contains("与画面同源")));
    }

    #[test]
    fn pricing_rules() {
        // Seedream 5.0 pro：1080x1920（207 万像素 ≤ 261 万）→ 0.30；超档 → 0.60
        assert!((image_unit_cost("doubao-seedream-5-0-pro-260628", "1080x1920", 0) - 0.30).abs() < 1e-9);
        assert!((image_unit_cost("doubao-seedream-5-0-pro-260628", "2560x1440", 0) - 0.60).abs() < 1e-9);
        // flash 0.12；参考图每张 +0.02
        assert!((image_unit_cost("doubao-seedream-5-0-flash-260915", "1080x1920", 3) - 0.18).abs() < 1e-9);
        // Seedance 720p 5s = 1.51 × 5 = 7.55（官方示例 7.56 是官方那头四舍五入）
        assert!((video_unit_cost("doubao-seedance-2-5-260628", "720p", 5) - 7.55).abs() < 1e-9);
        // duration=-1 按自动时长 15s 估
        assert!((video_unit_cost("doubao-seedance-2-5-260628", "1080p", -1) - 3.74 * 15.0).abs() < 1e-9);
        // mini 档按 token 单价比例打 5 折
        assert!((video_unit_cost("doubao-seedance-2-0-mini-260615", "720p", 5) - 7.55 * 0.5).abs() < 1e-9);
    }

    #[test]
    fn graph_cost_sums_gen_nodes_only() {
        // 1 张 Seedream 图 + 1 条 Seedance 720p 5s + 本地节点 0 元
        let g: Value = serde_json::from_str(
            r#"{
                "1": {"class_type": "StoryForgeSeedream", "inputs": {"prompt": "x", "model": "doubao-seedream-5-0-pro-260628", "size": "1080x1920"}},
                "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
                "3": {"class_type": "StoryForgeSeedance", "inputs": {"prompt": "x", "model": "doubao-seedance-2-5-260628", "duration": 5, "resolution": "720p"}},
                "4": {"class_type": "SaveVideo", "inputs": {"video": ["3", 0]}},
                "5": {"class_type": "EmptyImage", "inputs": {"width": 720, "height": 1280}}
            }"#,
        )
        .unwrap();
        let est = estimate_graph_cost(&g, "ark").unwrap();
        assert!((est - (0.30 + 7.55)).abs() < 1e-9, "est = {est}");
    }

    // ---------------- P1-2 Provider ----------------

    /// V4 签名对拍：与 OpenMontage jimeng_video.py 同算法复算的参照值（冻结时间）
    #[test]
    fn jimeng_v4_signature_matches_reference() {
        let body: &[u8] =
            r#"{"req_key": "jimeng_ti2v_v30_pro", "prompt": "测试", "frames": 121, "aspect_ratio": "9:16", "seed": -1}"#.as_bytes();
        let query = [("Action", "CVSync2AsyncSubmitTask"), ("Version", "2022-08-31")];
        let headers = jimeng_sign("AKTEST123", "SKTEST456", &query, body, "20261031T080000Z");
        let auth = headers
            .iter()
            .find(|(k, _)| k == "Authorization")
            .map(|(_, v)| v.clone())
            .unwrap();
        assert_eq!(
            auth,
            "HMAC-SHA256 Credential=AKTEST123/20261031/cn-north-1/cv/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=06ae1f841d6c1a1ed365217e69863dbc944571176a5ed5af90af7fa96ba089a9"
        );
    }

    #[test]
    fn pct_encode_matches_python_quote() {
        assert_eq!(pct_encode("CVSync2AsyncSubmitTask"), "CVSync2AsyncSubmitTask");
        assert_eq!(pct_encode("2022-08-31"), "2022-08-31", "- 属 unreserved");
        assert_eq!(pct_encode("a b/c"), "a%20b%2Fc");
        assert_eq!(pct_encode("测"), "%E6%B5%8B");
    }

    fn video_req(over: impl Fn(&mut VideoReq)) -> VideoReq {
        let mut r = VideoReq {
            node: "v1".into(),
            prompt: "测试".into(),
            model: "doubao-seedance-2-5-260628".into(),
            first_frame: None,
            last_frame: None,
            first_frame_url: String::new(),
            last_frame_url: String::new(),
            duration: 5,
            ratio: "adaptive".into(),
            resolution: "720p".into(),
            generate_audio: false,
            watermark: false,
            reference_urls: vec![],
            reference_prompt: String::new(),
        };
        over(&mut r);
        r
    }

    #[test]
    fn jimeng_payload_maps_duration_and_ratio() {
        let p = jimeng_payload(&video_req(|r| {
            r.duration = 5;
            r.ratio = "adaptive".into();
        }));
        assert_eq!(p["frames"], 121);
        assert_eq!(p["aspect_ratio"], "9:16", "adaptive 映射成竖屏");
        assert_eq!(p["req_key"], "jimeng_ti2v_v30_pro");
        assert!(p.get("image_urls").is_none(), "没有首帧就不带 image_urls");

        let p = jimeng_payload(&video_req(|r| {
            r.duration = 12;
            r.ratio = "16:9".into();
            r.first_frame_url = "https://example.com/f.png".into();
        }));
        assert_eq!(p["frames"], 241, ">=10s 用 241 帧");
        assert_eq!(p["aspect_ratio"], "16:9");
        assert_eq!(p["image_urls"], json!(["https://example.com/f.png"]));
    }

    #[test]
    fn jimeng_routing_falls_back() {
        // 兼容：无尾帧 / 无参考 / 不要音频 → 可以用即梦
        assert!(jimeng_can_serve("jimeng", false, false, false, true).is_ok());
        // 有音频要求 → 回落（错误信息说明原因）
        assert!(jimeng_can_serve("jimeng", false, false, true, true).is_err());
        // 没配 AK → 回落
        assert!(jimeng_can_serve("jimeng", false, false, false, false).is_err());
        // 选的是 ark → 永远直接走
        assert!(jimeng_can_serve("ark", true, true, true, false).is_ok());
    }

    #[test]
    fn jimeng_pricing_and_fallback_pricing() {
        let mk_def = |class: &str, extra: Value| -> NodeDef {
            let mut inputs = json!({
                "prompt": "x", "model": "doubao-seedance-2-5-260628",
                "duration": 5, "resolution": "720p",
            });
            if let (Some(obj), Some(e)) = (inputs.as_object_mut(), extra.as_object()) {
                for (k, v) in e {
                    obj.insert(k.clone(), v.clone());
                }
            }
            NodeDef { class_type: class.into(), inputs }
        };
        // 即梦兼容（无音频）→ 按条
        let d = mk_def("DramaShotVideo", json!({"generate_audio": false}));
        assert!((node_unit_cost_routed(&d, "jimeng") - JIMENG_CNY_PER_CLIP).abs() < 1e-9);
        // 要音频 → 不兼容即梦，按 ARK 表
        let d = mk_def("DramaShotVideo", json!({"generate_audio": true}));
        assert!((node_unit_cost_routed(&d, "jimeng") - 7.55).abs() < 1e-9);
        // 选 ark → 按 ARK 表
        let d = mk_def("DramaShotVideo", json!({"generate_audio": false}));
        assert!((node_unit_cost_routed(&d, "ark") - 7.55).abs() < 1e-9);
    }
}
