// 用 ?raw 读入再解析，避免 TS 为 JSON 生成类型
import rawText from "./node-library.json?raw";

/* ------------------------------------------------------------------ *
 * 节点目录
 * 内核时代的白名单：只有这里列出的节点能被原生内核执行，
 * 图里出现目录外的 class_type 会在提交时被内核拒收。
 * ------------------------------------------------------------------ */

export interface LibInput {
  k: string;
  t: string;
  req: 0 | 1;
  opts?: string[];
  trunc?: number;
  def?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  multi?: 1;
  tip?: string;
  // 动态下拉：可选项来自 schema 的 options
  dyn?: 1;
  // 可变输入：真实键名是 grow0 / grow1 ...
  grow?: string;
  gmin?: number;
  gmax?: number;
  gt?: string;
}

export interface LibNode {
  n: string;
  d: string;
  c: string;
  desc?: string;
  in: LibInput[];
  out: string[];
  api?: 1;
}

interface Lib {
  version: string;
  generatedAt: string;
  stats: { total: number; usable: number; needWeights: number; partner: number };
  nodes: LibNode[];
  reference: LibNode[];
  blocked: { n: string; d: string; c: string; why: string[] }[];
}

const lib = JSON.parse(rawText) as Lib;

export const LIB_VERSION = lib.version;
export const LIB_STATS = lib.stats;
export const NODES: LibNode[] = lib.nodes;
export const NODE_INDEX = new Map<string, LibNode>(NODES.map((n) => [n.n, n]));
/** 第三方 API 节点，仅作参数设计参考，不可直接执行 */
export const REFERENCE_NODES = lib.reference;
/** 需要本地模型权重、当前环境跑不了的节点 */
export const BLOCKED_INDEX = new Map<string, { why: string[] }>(
  (lib.blocked || []).map((b) => [b.n, { why: b.why }])
);

/* ------------------------------------------------------------------ *
 * 核心工具箱：短剧全链路的骨架，每次对话都放进上下文
 * 内核时代的节点目录：生成直连 ARK，像素杂活交给 ffmpeg，全部免权重
 * ------------------------------------------------------------------ */

const CORE = [
  // 生成（直连火山 ARK）
  "DramaCharacter",
  "DramaShotFrame",
  "DramaShotVideo",
  "DramaContinuity",
  "StoryForgeSeedream",
  "StoryForgeSeedance",
  // 输入输出
  "EmptyImage",
  "ImageScale",
  "LoadImage",
  "LoadVideo",
  "SaveImage",
  "SaveVideo",
];

/** 核心节点，按库中顺序去重 */
export const CORE_NODES: LibNode[] = (() => {
  const seen = new Set<string>();
  const out: LibNode[] = [];
  for (const name of CORE) {
    const n = NODE_INDEX.get(name);
    if (n && !seen.has(name)) {
      out.push(n);
      seen.add(name);
    }
  }
  return out;
})();

/** 核心集里缺失的节点名（用于提示节点库不完整） */
export const MISSING_CORE = CORE.filter((n) => !NODE_INDEX.has(n));

/* ------------------------------------------------------------------ *
 * 中文意图 -> 英文节点词
 * 模型和节点库都是英文，用户说的是中文，这层是桥梁
 * ------------------------------------------------------------------ */

const ZH_INTENT: [RegExp, string[]][] = [
  [/裁|切边|构图|取景/, ["crop", "center", "pad"]],
  [/缩放|放大|缩小|尺寸|分辨率|画幅|竖屏|横屏/, ["scale", "resize", "resolution"]],
  [/遮罩|蒙版|抠|去背|局部/, ["mask", "alpha"]],
  [/拼|网格|九宫格|序列图|分格/, ["grid", "stitch", "batch"]],
  [/模糊|虚化|景深/, ["blur"]],
  [/锐|清晰/, ["sharpen"]],
  [/调色|色彩|色调|色温|滤镜/, ["color", "transfer", "hdr", "normalize"]],
  [/反色|负片/, ["invert"]],
  [/视频|成片|剪辑|片段|镜头/, ["video", "savevideo", "concatenate", "trim"]],
  [/插帧|补帧|流畅|慢动作/, ["interpolate", "frame"]],
  [/音频|配音|旁白|bgm|音乐|声音/, ["audio", "empty"]],
  [/字幕|文字|标题|水印/, ["text", "overlay"]],
  [/旋转|翻转|镜像/, ["rotate", "flip"]],
  [/混合|叠化|双曝|叠加/, ["blend", "composite"]],
  [/首帧|尾帧|参考图|垫图/, ["seedream", "seedance", "reference", "first", "last"]],
  [/时长|秒/, ["duration", "trim"]],
  [/导出|保存|输出/, ["save", "preview"]],
  [/尺寸|宽高/, ["getimagesize", "size"]],
];

/** 从用户这句话里提取命中的英文节点词 */
function intentTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const [re, words] of ZH_INTENT) {
    if (re.test(query)) words.forEach((w) => terms.add(w));
  }
  // 英文直接命中
  const latin = query.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || [];
  latin.forEach((w) => terms.add(w));
  return [...terms];
}

/* ------------------------------------------------------------------ *
 * 检索
 * ------------------------------------------------------------------ */

function scoreNode(n: LibNode, terms: string[]): number {
  const name = n.n.toLowerCase();
  const display = n.d.toLowerCase();
  const cat = n.c.toLowerCase();
  const desc = (n.desc || "").toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (name.includes(t)) score += 6;
    else if (display.includes(t)) score += 4;
    else if (cat.includes(t)) score += 3;
    else if (desc.includes(t)) score += 1;
  }
  // 同分类里越短的名字越可能是主节点
  if (score > 0 && name.length < 14) score += 1;
  return score;
}

/**
 * 按用户意图召回核心集之外的节点，返回节点名
 */
export function searchNodes(query: string, k = 10): string[] {
  const terms = intentTerms(query);
  if (!terms.length) return [];
  const coreSet = new Set(CORE_NODES.map((n) => n.n));
  return NODES.filter((n) => !coreSet.has(n.n))
    .map((n) => ({ node: n, s: scoreNode(n, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.node.n);
}

/* ------------------------------------------------------------------ *
 * 渲染成给模型看的节点卡
 * ------------------------------------------------------------------ */

function renderInput(i: LibInput): string {
  if (i.grow) {
    return `${i.grow}0/${i.grow}1/…:${i.gt || "?"}（可变输入，键名用 ${i.grow}0、${i.grow}1 递增，至少 ${i.gmin ?? 1} 个）`;
  }  const bits = [`${i.k}:${i.t}`];
  if (i.req) bits.push("必填");
  if ((i.t === "COMBO" || i.dyn) && i.opts) {
    const opts = i.trunc ? `${i.opts.slice(0, 6).join("|")}|…(${i.trunc}选1)` : i.opts.join("|");
    bits.push(`=[${opts}]`);
  } else if (i.def !== undefined) {
    bits.push(`默认=${JSON.stringify(i.def)}`);
  }
  if (i.min !== undefined && i.max !== undefined && i.t === "INT") {
    bits.push(`范围${i.min}~${i.max}`);
  }
  return bits.join(" ");
}

export function renderNodeCard(n: LibNode): string {
  const ins = n.in.map(renderInput).join("，") || "无";
  const outs = n.out.join(",") || "无";
  const desc = n.desc ? `「${n.desc}」` : `「${n.d}」`;
  return `- ${n.n} ${desc} 输入{${ins}} 输出[${outs}]`;
}

export interface NodeContext {
  core: LibNode[];
  extra: LibNode[];
  text: string;
}

/**
 * 为一轮对话组装节点上下文：核心集 + 意图召回
 */
export function buildNodeContext(query: string, extraK = 10): NodeContext {
  const extraNames = searchNodes(query, extraK);
  const extra = extraNames.map((n) => NODE_INDEX.get(n)!).filter(Boolean);
  const sections: string[] = [];

  sections.push("### 核心工具箱（短剧全链路，优先使用）");
  sections.push(CORE_NODES.map(renderNodeCard).join("\n"));

  if (extra.length) {
    sections.push("");
    sections.push("### 本次意图可能用到的补充节点");
    sections.push(extra.map(renderNodeCard).join("\n"));
  }

  return { core: CORE_NODES, extra, text: sections.join("\n") };
}
