// 从运行中的 ComfyUI 拉取全量节点定义，生成前端可打包的节点库
// 用法: pnpm nodes [--port 8188]
import { writeFileSync } from "node:fs";

const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 8188);
const OUT = new URL("../src/lib/node-library.json", import.meta.url);

const res = await fetch(`http://127.0.0.1:${port}/object_info`);
if (!res.ok) throw new Error(`object_info ${res.status}`);
const oi = await res.json();

let comfyVersion = "unknown";
try {
  const st = await (await fetch(`http://127.0.0.1:${port}/system_stats`)).json();
  comfyVersion = st?.system?.comfyui_version || "unknown";
} catch {
  /* 拿不到版本不影响节点库生成 */
}

const WEIGHT_TYPES = new Set([
  "MODEL", "CLIP", "VAE", "CLIP_VISION", "CLIP_VISION_OUTPUT", "CONTROL_NET",
  "LORA", "UPSCALE_MODEL", "STYLE_MODEL", "GLIGEN", "PHOTOMAKER", "MODEL_PATCH",
  "VAE_ATTN", "CLIP_VISION_PROJECTION", "SAMPLER", "SIGMAS", "NOISE", "GUIDER",
  "SAMPLER_CUSTOM", "GUIDER_CUSTOM", "LATENT_UPSCALE_MODEL", "IMAGE_ENCODER",
  "TAESD", "PIXELSPACE_ENCODER", "AUDIO_ENCODER", "MASK_ENCODER",
  "CLIP_TEXT_ENCODER", "LATENT",
]);

const shortType = (spec) => {
  if (!Array.isArray(spec)) return null;
  const t = spec[0];
  if (Array.isArray(t)) return "COMBO";
  return typeof t === "string" ? t : null;
};

// 解析一个输入定义 -> 紧凑描述
const parseInput = (key, spec, required) => {
  const type = shortType(spec);
  const opts = Array.isArray(spec) ? spec[1] || {} : {};
  const item = { k: key, t: type || "?", req: required ? 1 : 0 };
  if (type === "COMBO" && Array.isArray(spec[0])) {
    const choices = spec[0];
    // 选项完整保留用于校验；超过 24 个只存前 24 个并标记，校验时不做取值约束
    if (choices.length > 24) {
      item.opts = choices.slice(0, 24).map(String);
      item.trunc = choices.length;
    } else {
      item.opts = choices.map(String);
    }
  }
  // 动态下拉：options 是 [{key, inputs}]，可选项是 key，第一个当默认
  if (type === "COMFY_DYNAMICCOMBO_V3" && Array.isArray(opts.options)) {
    const keys = opts.options.map((o) => o && o.key).filter((x) => typeof x === "string");
    if (keys.length) {
      item.opts = keys;
      item.def = keys[0];
      item.dyn = 1;
    }
  }
  // 可变输入：真实键名是 <输入id>.<prefix><序号>，如 videos.video0
  if (type === "COMFY_AUTOGROW_V3" && opts.template) {
    const tpl = opts.template;
    item.grow = `${key}.${tpl.prefix || "input"}`;
    item.gmin = tpl.min ?? 1;
    item.gmax = tpl.max ?? 10;
    const tspec = tpl.input?.required ? Object.values(tpl.input.required)[0] : null;
    const tt = tspec ? shortType(tspec) : null;
    if (tt) item.gt = tt;
  }
  const dv = opts.default;
  if (dv !== undefined && dv !== null && typeof dv !== "object") item.def = dv;
  if (opts.min !== undefined) item.min = opts.min;
  if (opts.max !== undefined) item.max = opts.max;
  if (opts.step !== undefined) item.step = opts.step;
  if (opts.multiline) item.multi = 1;
  if (opts.tooltip) item.tip = String(opts.tooltip).slice(0, 140);
  return item;
};

const usable = [];
const needWeights = [];
const partner = [];

for (const [name, n] of Object.entries(oi)) {
  const cat = n.category || "";
  const display = n.display_name || name;
  const req = Object.entries(n.input?.required || {}).map(([k, v]) => parseInput(k, v, true));
  const opt = Object.entries(n.input?.optional || {}).map(([k, v]) => parseInput(k, v, false));
  const all = [...req, ...opt];
  const hasWeight = all.some((i) => i.t && WEIGHT_TYPES.has(i.t));
  const desc = String(n.description || "").slice(0, 220);

  const rec = {
    n: name,
    d: display,
    c: cat,
    in: all.filter((i) => i.t !== "LATENT"),
    out: n.output || [],
  };
  if (desc) rec.desc = desc;

  if (cat.startsWith("partner/")) {
    // 第三方 API 节点：不直接可用，但参数设计是重要参考
    rec.api = 1;
    partner.push(rec);
  } else if (hasWeight) {
    needWeights.push({ n: name, d: display, c: cat, why: all.filter((i) => WEIGHT_TYPES.has(i.t)).map((i) => i.t) });
  } else {
    usable.push(rec);
  }
}

const payload = {
  version: comfyVersion,
  generatedAt: new Date().toISOString(),
  stats: { total: Object.keys(oi).length, usable: usable.length, needWeights: needWeights.length, partner: partner.length },
  nodes: usable,
  // 参考库：第三方 API 节点的参数结构，用于设计我们自己的领域节点
  reference: partner,
  blocked: needWeights,
};

writeFileSync(OUT, JSON.stringify(payload), "utf8");
const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(0);
console.log(`nodes=${usable.length} reference=${partner.length} blocked=${needWeights.length}`);
console.log(`-> app/src/lib/node-library.json (${kb} KB)`);
