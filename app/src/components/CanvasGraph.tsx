import { useEffect, useMemo, useRef, useState } from "react";
import { NODE_INDEX, NODES } from "../lib/nodeSearch";
import { applyGraphOps } from "../lib/graphOps";
import { diffSummary, touchedIds } from "../lib/graphAudit";
import { useStore } from "../lib/store";
import type { CanvasDoc, NodeRun } from "../lib/store";
import type { ComfyGraph } from "../types";
import { Btn, I, Spinner, Tag, cx } from "./ui";

/* ------------------------------------------------------------------ *
 * 节点画布
 * 交互按 ComfyUI 的习惯做：滚轮在指针处缩放、空白拖动平移、
 * 双击空白弹出节点搜索、右键菜单、拖线自动吸附最近端口
 * 纯 SVG + HTML，无第三方依赖；图永远是 ComfyUI API 格式
 * ------------------------------------------------------------------ */

const NODE_W = 204;
const HEADER_H = 26;
const ROW_H = 19;
const GAP_Y = 22;
const PAD_X = 24;
const GRID = 8;
/** 端口圆心相对节点边缘的外扩距离（端口 14px，左移 15px 再取半径） */
const PORT_OFF = 8;
/** 输出区与输入区之间的分隔线留白 */
const OUT_GAP = 4;

const MIN_K = 0.3;
const MAX_K = 2.4;

const SCALAR_TYPES = new Set(["COMBO", "INT", "FLOAT", "BOOLEAN"]);

/* ComfyUI litegraph 的槽位配色，按类型上色，一眼能看出线是什么 */
const SLOT_COLORS: Record<string, string> = {
  CLIP: "#FFD500",
  CLIP_VISION: "#A8DADC",
  CLIP_VISION_OUTPUT: "#ad7452",
  CONDITIONING: "#FFA931",
  CONTROL_NET: "#6EE7B7",
  IMAGE: "#64B5F6",
  LATENT: "#FF9CF9",
  MASK: "#81C784",
  MODEL: "#B39DDB",
  STYLE_MODEL: "#C2FFAE",
  VAE: "#FF6E6E",
  NOISE: "#B0B0B0",
  GUIDER: "#66FFFF",
  SAMPLER: "#ECB4B4",
  SIGMAS: "#CDFFCD",
  TAESD: "#DCC274",
  VIDEO: "#e0b166",
  AUDIO: "#8fd6a8",
  STRING: "#9a9aa3",
  INT: "#9a9aa3",
  FLOAT: "#9a9aa3",
  BOOLEAN: "#9a9aa3",
  COMBO: "#9a9aa3",
};

const slotColor = (t?: string) => (t && SLOT_COLORS[t]) || "#8f8f99";

interface Pos {
  x: number;
  y: number;
}

interface LibSpecLike {
  k: string;
  t: string;
  /** 1 = 必填 */
  req?: 0 | 1;
  grow?: string;
  dyn?: number;
  opts?: string[];
  trunc?: number;
  multi?: number;
  min?: number;
  max?: number;
  step?: number;
  def?: unknown;
}

function cardOf(classType: string) {
  return NODE_INDEX.get(classType);
}

/** 该输入是否可作为连线端点（标量参数不是端口，STRING 只允许 _url 传递） */
function inputEligible(classType: string, key: string): boolean {
  const spec = cardOf(classType)?.in.find((s) => s.k === key) as LibSpecLike | undefined;
  if (!spec) return false;
  if (spec.grow || spec.dyn) return false;
  if (SCALAR_TYPES.has(spec.t)) return key.endsWith("_url");
  return true;
}

function inType(classType: string, key: string): string | undefined {
  return (cardOf(classType)?.in.find((s) => s.k === key) as LibSpecLike | undefined)?.t;
}

function outTypes(classType: string): string[] {
  return cardOf(classType)?.out ?? [];
}

function typeMatch(src: string | undefined, dst: string | undefined): boolean {
  if (!src || !dst) return false;
  return src === "*" || dst === "*" || src === dst;
}

/** 可选输入默认折叠的判定：非必填、没接线、也没填值 */
type Row = { key: string; spec?: LibSpecLike };

/** 这个输入到底"有没有东西"：空了就等于没设置，可以收起来 */
function hasValue(v: unknown): boolean {
  if (Array.isArray(v)) return true;
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  return true;
}

/**
 * 节点上要显示哪些输入行。
 * 可选项默认收起来——一个视频节点摊开 14 行，多镜图根本没法看；
 * 接了线的、填过值的、必填的、以及用户点开「＋N 可选」的那些才显示。
 */
function inputRows(graph: ComfyGraph, id: string, expand?: Set<string>): Row[] {
  const node = graph[id];
  const card = cardOf(node?.class_type || "");
  const inputs = node?.inputs || {};
  const open = expand?.has(id) ?? false;
  const rows: Row[] = [];
  const declared = new Set<string>();
  if (card) {
    for (const s of card.in as LibSpecLike[]) {
      declared.add(s.k);
      if (s.grow || s.dyn) continue;
      if (!s.req && !hasValue(inputs[s.k]) && !open) continue;
      rows.push({ key: s.k, spec: s });
    }
  }
  // 卡上没声明、但图里真有的输入（自定义/动态键）：一律照实显示
  for (const k of Object.keys(inputs)) {
    if (declared.has(k)) continue;
    if (!rows.some((r) => r.key === k)) rows.push({ key: k });
  }
  return rows;
}

/** 这张卡上所有"能收起来"的可选输入，与当前是否展开无关 */
function optionalKeys(graph: ComfyGraph, id: string): string[] {
  const node = graph[id];
  const card = cardOf(node?.class_type || "");
  if (!card) return [];
  const inputs = node?.inputs || {};
  return (card.in as LibSpecLike[])
    .filter((s) => !s.grow && !s.dyn && !s.req && !hasValue(inputs[s.k]))
    .map((s) => s.k);
}

/** 当前真的被折叠掉的那些（收起时才有，用来算高度和锚点） */
function foldedRows(graph: ComfyGraph, id: string, expand?: Set<string>): string[] {
  if (expand?.has(id)) return [];
  return optionalKeys(graph, id);
}

/** 节点真实高度：可见行 + （有折叠时那一条「＋N」） + 输出区 */
function nodeHeight(graph: ComfyGraph, id: string, expand?: Set<string>): number {
  const node = graph[id];
  if (!node) return HEADER_H;
  const rows = inputRows(graph, id, expand).length + (foldedRows(graph, id, expand).length ? 1 : 0);
  const outs = outTypes(node.class_type).length;
  if (!rows && !outs) return HEADER_H + 26;
  return HEADER_H + rows * ROW_H + (outs ? OUT_GAP : 0) + outs * ROW_H;
}

/** 输入端口锚点：第 i 行左边缘外侧 */
function inAnchor(p: Pos, i: number): Pos {
  return { x: p.x - PORT_OFF, y: p.y + HEADER_H + i * ROW_H + ROW_H / 2 };
}

/** 输出端口锚点：输入区（含折叠行）之后单独一段 */
function outAnchor(graph: ComfyGraph, id: string, p: Pos, j: number, expand?: Set<string>): Pos {
  const n =
    inputRows(graph, id, expand).length + (foldedRows(graph, id, expand).length ? 1 : 0);
  const outs = outTypes(graph[id]?.class_type || "").length;
  return {
    x: p.x + NODE_W + PORT_OFF,
    y: p.y + HEADER_H + n * ROW_H + (outs ? OUT_GAP : 0) + j * ROW_H + ROW_H / 2,
  };
}

/** ComfyUI 同款连线段：水平控制点按间距伸缩，短线也不会打结 */
function linkPath(a: Pos, b: Pos): string {
  const dx = Math.max(36, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function computeLayout(graph: ComfyGraph, expand?: Set<string>): {
  positions: Record<string, Pos>;
  width: number;
  height: number;
} {
  const memo = new Map<string, number>();
  const depth = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    memo.set(id, 0);
    const node = graph[id];
    let d = 0;
    for (const v of Object.values<any>(node?.inputs || {})) {
      if (Array.isArray(v) && typeof v[0] === "string" && graph[v[0]]) {
        d = Math.max(d, depth(v[0]) + 1);
      }
    }
    memo.set(id, d);
    return d;
  };

  const layers = new Map<number, string[]>();
  for (const id of Object.keys(graph)) {
    const d = depth(id);
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(id);
  }

  const positions: Record<string, Pos> = {};
  let width = 0;
  for (const [d, ids] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    const x = PAD_X + d * (NODE_W + 52);
    let y = PAD_X;
    for (const id of ids) {
      positions[id] = { x, y };
      y += nodeHeight(graph, id, expand) + GAP_Y;
    }
    width = Math.max(width, x + NODE_W + PAD_X);
  }
  const height = Math.max(
    ...Object.keys(graph).map((id) => positions[id].y + nodeHeight(graph, id, expand) + PAD_X),
    240
  );
  return { positions, width, height };
}

export function ParamEditor({
  graph,
  nodeId,
  onChange,
}: {
  graph: ComfyGraph;
  nodeId: string;
  onChange: (key: string, value: unknown) => void;
}) {
  const node = graph[nodeId];
  if (!node) return null;
  const card = cardOf(node.class_type);

  const entries = Object.entries(node.inputs || {}).filter(([, v]) => !Array.isArray(v));
  if (!entries.length) {
    return <div className="t-12 text-[var(--fg-4)]">这个节点没有可编辑的参数。</div>;
  }

  return (
    <div className="space-y-2">
      {entries.map(([key, value]) => {
        const spec = card?.in.find((s) => s.k === key) as LibSpecLike | undefined;
        if (spec?.grow || spec?.dyn) return null;

        let field: React.ReactElement;
        if (spec?.opts && !spec.trunc) {
          field = (
            <select
              value={String(value)}
              onChange={(e) => onChange(key, e.target.value)}
              className={editCls}
            >
              {spec.opts.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          );
        } else if (typeof value === "boolean" || spec?.t === "BOOLEAN") {
          field = (
            <label className="flex h-[26px] cursor-pointer items-center gap-2 t-12 text-[var(--fg-2)]">
              <input
                type="checkbox"
                checked={Boolean(value)}
                onChange={(e) => onChange(key, e.target.checked)}
                className="accent-[var(--accent)]"
              />
              {Boolean(value) ? "开" : "关"}
            </label>
          );
        } else if (typeof value === "number") {
          field = (
            <input
              type="number"
              value={value}
              min={spec?.min}
              max={spec?.max}
              step={spec?.step}
              onChange={(e) => {
                const n = Number(e.target.value);
                onChange(key, Number.isFinite(n) ? n : 0);
              }}
              className={editCls}
            />
          );
        } else if (spec?.multi || (typeof value === "string" && value.length > 60)) {
          field = (
            <textarea
              value={String(value)}
              rows={3}
              onChange={(e) => onChange(key, e.target.value)}
              className="field area text-[11.5px]"
            />
          );
        } else {
          field = (
            <input
              value={String(value)}
              onChange={(e) => onChange(key, e.target.value)}
              className={editCls}
            />
          );
        }

        return (
          <label key={key} className="block">
            <div className="mb-1 flex items-center justify-between">
              <span className="t-11 font-mono text-[var(--fg-3)]">{key}</span>
              {spec?.t && !SCALAR_TYPES.has(spec.t) ? (
                <span className="t-11 text-[var(--fg-4)]">{spec.t}</span>
              ) : null}
            </div>
            {field}
          </label>
        );
      })}
    </div>
  );
}

const editCls = "field h-[26px] text-[11.5px]";

type LinkDrag =
  | { mode: "out"; fromId: string; outIdx: number; outType: string; mx: number; my: number }
  | { mode: "in"; toId: string; toKey: string; inType: string; mx: number; my: number };

interface SnapTarget {
  side: "in" | "out";
  id: string;
  key?: string;
  idx?: number;
  type: string;
  at: Pos;
}

type Menu =
  | { kind: "canvas"; x: number; y: number }
  | { kind: "node"; x: number; y: number; id: string }
  | { kind: "link"; x: number; y: number; id: string; key: string };

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const snapGrid = (v: number) => Math.round(v / GRID) * GRID;

export function CanvasGraph({
  doc,
  busy,
  stage,
  focus,
  baseGraph,
  onGraphChange,
  onFocusNode,
  onRun,
  onCancel,
  onReset,
  runNodes,
  runNow,
}: {
  /** 画布的唯一来源：AI 改的、人改的、执行出来的，都是这一份 */
  doc: CanvasDoc;
  busy: boolean;
  /** 正在做什么（AI 改图 / 生成中都显示在工具栏上） */
  stage?: string;
  /** 要指给用户看的节点（点了报错、点了改动条目） */
  focus?: { id: string; at: number } | null;
  /** 最近一次生成出来的图：用来标出画布上哪几个节点是这之后改的 */
  baseGraph?: ComfyGraph | null;
  onFocusNode?: (id: string) => void;
  onGraphChange: (g: ComfyGraph) => void;
  /** 唯一的生成入口 */
  onRun: () => void;
  /** 跑的时候可以停 */
  onCancel?: () => void;
  /** 丢掉改动，回到最近一次执行出来的那张图 */
  onReset: () => void;
  /** 生成过程中的节点状态：跑到哪个节点、跑到几成 */
  runNodes?: Record<string, NodeRun>;
  runNow?: string | null;
}) {
  /** 画布永远是编辑器：没有只读态，人和 AI 改的是同一张图 */
  const editing = true;
  const [selIds, setSelIds] = useState<string[]>([]);
  const [selLink, setSelLink] = useState<{ id: string; key: string } | null>(null);
  const [positions, setPositions] = useState<Record<string, Pos>>({});
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [linkDrag, setLinkDrag] = useState<LinkDrag | null>(null);
  const [snap, setSnap] = useState<SnapTarget | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null
  );
  const [menu, setMenu] = useState<Menu | null>(null);
  const [picker, setPicker] = useState<{ at: Pos; sx: number; sy: number } | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  /** AI 刚动过的节点：高亮 7 秒，让人看见它动了哪儿 */
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [showChange, setShowChange] = useState(false);
  /** 手动点开「＋N 可选」的节点：默认收起，省出来的高度就是可读性。
   *  状态随工程走（存 project.json，换机器/换工程都还在），不再只存本机 */
  const expandedIds = useStore((s) => s.expandedIds);
  const setExpandedIds = useStore((s) => s.setExpandedIds);
  const expanded = useMemo(() => new Set(expandedIds), [expandedIds]);

  const containerRef = useRef<HTMLDivElement>(null);
  const lastRunId = useRef<string>("");
  const viewRef = useRef(view);
  const hintTimer = useRef<number | null>(null);
  /** 布局刚换过：等 positions 落地后自动缩放到"看得见整张图" */
  const fitPending = useRef(true);
  /** 从已连线的输入上拖走：真正移动了才断开，纯点击不该毁掉连线 */
  const detachRef = useRef<{ id: string; key: string } | null>(null);
  viewRef.current = view;

  /** 画布读的就是 store 里那一份：没有本地副本，也就没有"改完一帧才生效"的错位 */
  const graph = doc.graph;
  const rowsOf = (id: string) => inputRows(graph, id, expanded);
  const foldOf = (id: string) => foldedRows(graph, id, expanded);
  const optOf = (id: string) => optionalKeys(graph, id);
  const hOf = (id: string) => nodeHeight(graph, id, expanded);
  const outAt = (id: string, p: Pos, j: number) => outAnchor(graph, id, p, j, expanded);
  const layout = useMemo(() => computeLayout(graph, expanded), [graph, expanded]);
  /** 展开/收起可选输入：纯视图状态，不动图，也不进撤销；随工程持久化，刷新后还是你摊开的那几个 */
  const toggleExpand = (id: string) => {
    const n = new Set(expanded);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setExpandedIds([...n]);
  };
  const opsCtx = useMemo(
    () => ({
      cardOf: (ct: string) => {
        const c = NODE_INDEX.get(ct);
        return c ? { display: c.d, in: c.in, out: c.out } : undefined;
      },
    }),
    []
  );

  const flash = (msg: string) => {
    setHint(msg);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), 3600);
  };

  // 换了一份文档（AI 出了新图 / 执行完了 / 还原）：整张重排并适配视图；
  // 同一份文档内的增删节点：保留手工摆位，只补新节点
  useEffect(() => {
    if (lastRunId.current !== doc.id) {
      lastRunId.current = doc.id;
      setPositions(layout.positions);
      fitPending.current = true;
      setSelIds([]);
      setSelLink(null);
      setPicker(null);
      return;
    }
    setPositions((prev) => {
      const next = { ...prev };
      for (const id of Object.keys(prev)) {
        if (!layout.positions[id]) delete next[id];
      }
      for (const [id, p] of Object.entries(layout.positions)) {
        if (!next[id]) next[id] = p;
      }
      return next;
    });
  }, [layout, doc.id]);

  const mutateDraft = (fn: (g: ComfyGraph) => void) => {
    const next = JSON.parse(JSON.stringify(graph)) as ComfyGraph;
    fn(next);
    onGraphChange(next);
  };

  const setParam = (nodeId: string, key: string, value: unknown) => {
    mutateDraft((g) => {
      g[nodeId].inputs[key] = value;
    });
  };

  const detach = (toId: string, toKey: string) => {
    mutateDraft((g) => {
      delete g[toId].inputs[toKey];
    });
  };

  const connect = (toId: string, toKey: string, fromId: string, outIdx: number): boolean => {
    const toNode = graph[toId];
    if (!toNode) return false;
    const t = inType(toNode.class_type, toKey);
    const srcType = outTypes(graph[fromId]?.class_type || "")[outIdx];
    if (!typeMatch(srcType, t)) {
      flash(`类型不匹配：${toKey} 需要 ${t ?? "?"}，来源输出是 ${srcType ?? "?"}`);
      return false;
    }
    if (fromId === toId) {
      flash("不能连到自己");
      return false;
    }
    mutateDraft((g) => {
      g[toId].inputs[toKey] = [fromId, outIdx];
    });
    flash(`已连接 ${toKey} ← #${fromId}[${outIdx}]`);
    return true;
  };

  /* ------------------------- 坐标换算 ------------------------- */

  const screenToContent = (clientX: number, clientY: number): Pos => {
    const rect = containerRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - (rect?.left ?? 0) - v.x) / v.k,
      y: (clientY - (rect?.top ?? 0) - v.y) / v.k,
    };
  };

  const localXY = (clientX: number, clientY: number): Pos => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  /* ------------------------- 缩放 / 平移 ------------------------- */

  /** 以屏幕上某点为锚做等比缩放；用函数式更新，连续滚轮也不会丢增量 */
  const zoomBy = (factor: number, mx: number, my: number) => {
    setView((v) => {
      const k = clamp(v.k * factor, MIN_K, MAX_K);
      const r = k / v.k;
      return { k, x: mx - (mx - v.x) * r, y: my - (my - v.y) * r };
    });
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (e.shiftKey) {
        // Shift + 滚轮：横向平移，长图看右边很顺手
        setView((v) => ({ ...v, x: v.x - e.deltaY }));
        return;
      }
      zoomBy(Math.exp(-e.deltaY * 0.0016), mx, my);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const fitView = (): boolean => {
    const rect = containerRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 0;
    const h = rect?.height ?? 0;
    // 还没量出容器大小（首帧 / 面板刚展开）就先别算，算了也是错的比例
    if (w < 120 || h < 120) return false;
    const ids = Object.keys(positions);
    if (!ids.length) return false;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const id of ids) {
      const p = positions[id];
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + NODE_W);
      y1 = Math.max(y1, p.y + hOf(id));
    }
    const pad = 44;
    const bw = Math.max(1, x1 - x0);
    const bh = Math.max(1, y1 - y0);
    // 缩到能全放下为止；下限 0.62——再小字就没法看了，宁可让画布溢出、人自己平移
    const k = clamp(Math.min((w - pad * 2) / bw, (h - pad * 2) / bh), 0.62, 1);
    const fitsW = bw * k <= w - pad * 2;
    const fitsH = bh * k <= h - pad * 2;
    setView({
      k,
      x: (fitsW ? (w - bw * k) / 2 : pad) - x0 * k,
      y: (fitsH ? (h - bh * k) / 2 : pad) - y0 * k,
    });
    return true;
  };

  /** 把某个节点挪到视野正中，并选中它——"指出问题在哪"就靠这个 */
  const centerOn = (id: string) => {
    const p = positions[id];
    const el = containerRef.current;
    if (!p || !el) return;
    const rect = el.getBoundingClientRect();
    const k = Math.max(viewRef.current.k, 0.8);
    const h = hOf(id);
    setView({
      k,
      x: rect.width / 2 - (p.x + NODE_W / 2) * k,
      y: rect.height / 2 - (p.y + h / 2) * k,
    });
  };

  // positions 落地后补一次自动适应：换图时先看到整张图，再自己缩进去看细节
  useEffect(() => {
    if (!fitPending.current) return;
    if (fitView()) fitPending.current = false;
  }, [positions]);

  // 首帧容器还没量出大小时 fitView 会主动放弃；等画布真有尺寸了再补一次
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (fitPending.current && fitView()) fitPending.current = false;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [positions]);

  // 外部要求看某个节点（点了报错、点了改动清单）
  const lastFocus = useRef(0);
  useEffect(() => {
    if (!focus || focus.at === lastFocus.current) return;
    if (!positions[focus.id]) return;
    lastFocus.current = focus.at;
    centerOn(focus.id);
    setSelIds([focus.id]);
    setSelLink(null);
  }, [focus?.at, positions]);

  // AI 动完手：把动过的节点点亮一会儿，并摊开改动清单；
  // 铺图顺序：整版重铺时是全部节点，普通改动是改动涉及的节点。
  // 在 render 阶段就算出来（而不是 effect），第一帧就已经把它们藏好，
  // 否则会先整张图闪一下再开始演。
  const revealOrder = useMemo(() => {
    if (!doc.changedAt) return [] as string[];
    // 只演"新长出来的"节点：改参数就原位高亮，藏一下再冒出来反而像闪烁
    const order = (doc.rebuild ? Object.keys(graph) : (doc.change?.added ?? []).map((a) => a.id)).filter(
      (id) => graph[id]
    );
    // 一两个节点靠高亮就够了；整版重铺 / 大批改动才值得演一遍
    return order.length >= 3 && order.length <= 48 ? order : [];
  }, [doc.changedAt]);

  const [revealTick, setRevealTick] = useState<{ sig: number; n: number }>({ sig: 0, n: 0 });
  const revealedNow = doc.changedAt && revealTick.sig === doc.changedAt ? revealTick.n : 0;
  const revealTotal = revealOrder.length;
  const hiddenIds = useMemo(
    () => new Set(revealOrder.slice(revealedNow)),
    [revealOrder, revealedNow]
  );

  // 到点一个个长出来
  useEffect(() => {
    if (!revealOrder.length || !doc.changedAt) return;
    const sig = doc.changedAt;
    setRevealTick({ sig, n: 0 });
    let n = 0;
    const timer = window.setInterval(() => {
      n += 1;
      setRevealTick({ sig, n });
      if (n >= revealOrder.length) window.clearInterval(timer);
    }, 110);
    return () => window.clearInterval(timer);
  }, [revealOrder]);

  // AI 动完手：把动过的节点点亮一会儿，并摊开改动清单
  useEffect(() => {
    if (!doc.changedAt) return;
    const ids = new Set(doc.change ? touchedIds(doc.change) : []);
    setFlashIds(ids);
    setShowChange(!!doc.change && doc.change.total > 0);
    if (!ids.size) return;
    const t = window.setTimeout(() => setFlashIds(new Set()), 7000);
    return () => window.clearTimeout(t);
  }, [doc.changedAt]);

  /* ------------------------- 端口吸附 ------------------------- */

  /** 找离指针最近、类型兼容的端口；ComfyUI 就是这个手感，靠近就吸上去 */
  const nearestPort = (p: Pos, d: LinkDrag): SnapTarget | null => {
    const radius = 30 / viewRef.current.k;
    let best: SnapTarget | null = null;
    let bestD = radius;

    for (const [id, node] of Object.entries(graph)) {
      const pos = positions[id];
      if (!pos) continue;
      if (d.mode === "out" && id === d.fromId) continue;
      if (d.mode === "in" && id === d.toId) continue;

      if (d.mode === "out") {
        // 输出在拖，找输入的落点
        rowsOf(id).forEach((row, i) => {
          if (!inputEligible(node.class_type, row.key)) return;
          const t = row.spec?.t;
          if (!typeMatch(d.outType, t)) return;
          const at = inAnchor(pos, i);
          const dd = Math.hypot(at.x - p.x, at.y - p.y);
          if (dd < bestD) {
            bestD = dd;
            best = { side: "in", id, key: row.key, type: t || "?", at };
          }
        });
      } else {
        const outs = outTypes(node.class_type);
        outs.forEach((t, j) => {
          if (!typeMatch(t, d.inType)) return;
          const at = outAt(id, pos, j);
          const dd = Math.hypot(at.x - p.x, at.y - p.y);
          if (dd < bestD) {
            bestD = dd;
            best = { side: "out", id, idx: j, type: t, at };
          }
        });
      }
    }
    return best;
  };

  useEffect(() => {
    if (!linkDrag) return;
    const move = (e: PointerEvent) => {
      const p = screenToContent(e.clientX, e.clientY);
      const s = nearestPort(p, linkDrag);
      setSnap(s);
      if (detachRef.current) {
        detach(detachRef.current.id, detachRef.current.key);
        detachRef.current = null;
      }
      setLinkDrag((d) => (d ? { ...d, mx: s ? s.at.x : p.x, my: s ? s.at.y : p.y } : d));
    };
    const up = (e: PointerEvent) => {
      const p = screenToContent(e.clientX, e.clientY);
      const s = nearestPort(p, linkDrag);
      detachRef.current = null;
      if (s) {
        if (linkDrag.mode === "out" && s.side === "in") {
          connect(s.id, s.key!, linkDrag.fromId, linkDrag.outIdx);
        } else if (linkDrag.mode === "in" && s.side === "out") {
          connect(linkDrag.toId, linkDrag.toKey, s.id, s.idx!);
        }
      } else {
        // 没吸附上就退回 DOM 命中，保底
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const port = el?.closest("[data-port]") as HTMLElement | null;
        const info = port?.dataset;
        if (linkDrag.mode === "out" && info?.port === "in" && info?.eligible === "1") {
          connect(info.id!, info.key!, linkDrag.fromId, linkDrag.outIdx);
        } else if (linkDrag.mode === "in" && info?.port === "out") {
          connect(linkDrag.toId, linkDrag.toKey, info.id!, Number(info.idx));
        }
      }
      setSnap(null);
      setLinkDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [linkDrag, graph, positions]);

  const startLinkFromOut = (e: React.PointerEvent, id: string, idx: number) => {
    if (!editing) return;
    e.stopPropagation();
    const p = screenToContent(e.clientX, e.clientY);
    setLinkDrag({
      mode: "out",
      fromId: id,
      outIdx: idx,
      outType: outTypes(graph[id].class_type)[idx],
      mx: p.x,
      my: p.y,
    });
    setMenu(null);
  };

  const startLinkFromIn = (e: React.PointerEvent, id: string, key: string) => {
    if (!editing) return;
    e.stopPropagation();
    const p = screenToContent(e.clientX, e.clientY);
    detachRef.current = Array.isArray(graph[id]?.inputs?.[key]) ? { id, key } : null;
    setLinkDrag({
      mode: "in",
      toId: id,
      toKey: key,
      inType: inType(graph[id].class_type, key) || "*",
      mx: p.x,
      my: p.y,
    });
    setMenu(null);
  };

  /* ------------------------- 节点拖动 ------------------------- */

  const startNodeDrag = (e: React.PointerEvent, id: string) => {
    if (!editing || linkDrag) return;
    e.stopPropagation();
    setMenu(null);
    setPicker(null);
    if (e.button === 2) return;

    const ids = selIds.includes(id) ? selIds : [id];
    if (e.shiftKey) {
      setSelIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
    } else if (!selIds.includes(id)) {
      setSelIds([id]);
    }
    setSelLink(null);

    const p = screenToContent(e.clientX, e.clientY);
    const starts = ids
      .filter((nid) => positions[nid])
      .map((nid) => ({ id: nid, x: positions[nid].x, y: positions[nid].y }));
    if (!starts.length) return;
    let moved = false;

    const move = (ev: PointerEvent) => {
      const q = screenToContent(ev.clientX, ev.clientY);
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
      setPositions((s) => {
        const next = { ...s };
        for (const st of starts) {
          next[st.id] = { x: snapGrid(st.x + dx), y: snapGrid(st.y + dy) };
        }
        return next;
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved && !e.shiftKey) setSelIds([id]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /* ------------------------- 空白：平移 / 框选 ------------------------- */

  const onCanvasDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-node]") || target.closest("[data-port]")) return;
    if (e.button === 2) return;
    setMenu(null);
    setPicker(null);

    const rect = containerRef.current?.getBoundingClientRect();
    const ox = rect?.left ?? 0;
    const oy = rect?.top ?? 0;
    const start = localXY(e.clientX, e.clientY);
    // Ctrl / ⌘ + 拖 = 框选；其余空白拖动 = 平移（空格或中键也平移）
    const marqueeMode = (e.ctrlKey || e.metaKey) && editing;
    const wantPan = !marqueeMode || e.button === 1 || spaceHeld;
    if (e.button === 1) e.preventDefault();

    let moved = false;
    const v0 = { ...viewRef.current };
    const basePositions = { ...positions };

    const move = (ev: PointerEvent) => {
      const now = localXY(ev.clientX, ev.clientY);
      if (Math.abs(now.x - start.x) > 2 || Math.abs(now.y - start.y) > 2) moved = true;
      if (wantPan) {
        setView({ ...v0, x: v0.x + (now.x - start.x), y: v0.y + (now.y - start.y) });
        return;
      }
      const a = screenToContent(ox + start.x, oy + start.y);
      const b = screenToContent(ox + now.x, oy + now.y);
      setMarquee({
        x0: Math.min(a.x, b.x),
        y0: Math.min(a.y, b.y),
        x1: Math.max(a.x, b.x),
        y1: Math.max(a.y, b.y),
      });
    };

    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) {
        // 空白处单击（没拖动）= 取消选择，和 ComfyUI 一致
        setSelIds([]);
        setSelLink(null);
        setMarquee(null);
        return;
      }
      if (!wantPan) {
        const now = localXY(ev.clientX, ev.clientY);
        const a = screenToContent(ox + start.x, oy + start.y);
        const b = screenToContent(ox + now.x, oy + now.y);
        const box = {
          x0: Math.min(a.x, b.x),
          y0: Math.min(a.y, b.y),
          x1: Math.max(a.x, b.x),
          y1: Math.max(a.y, b.y),
        };
        const hit = Object.keys(basePositions).filter((id) => {
          const p = basePositions[id];
          if (!p) return false;
          const h = hOf(id);
          return p.x < box.x1 && p.x + NODE_W > box.x0 && p.y < box.y1 && p.y + h > box.y0;
        });
        setSelIds(hit);
        setMarquee(null);
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // 空格按住 = 抓手（ComfyUI 的手感）
  useEffect(() => {
    const typing = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e.target)) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  /* ------------------------- 连线 ------------------------- */

  const links = useMemo(() => {
    const out: {
      key: string;
      id: string;
      field: string;
      d: string;
      type: string;
      /** 上游节点 id：铺图动画要按两端决定这条线露不露 */
      src: string;
      from: Pos;
      to: Pos;
    }[] = [];
    for (const [id, node] of Object.entries(graph)) {
      const rows = rowsOf(id);
      for (const [key, v] of Object.entries<any>(node.inputs || {})) {
        if (!Array.isArray(v) || typeof v[0] !== "string" || !graph[v[0]]) continue;
        // 首帧渲染时 positions 还是空的，等布局算完再画线
        if (!positions[id] || !positions[v[0]]) continue;
        const i = rows.findIndex((r) => r.key === key);
        if (i < 0) continue;
        const from = outAt(v[0], positions[v[0]], v[1] ?? 0);
        const to = inAnchor(positions[id], i);
        out.push({
          key: `${id}.${key}`,
          id,
          field: key,
          d: linkPath(from, to),
          type: outTypes(graph[v[0]].class_type)[v[1] ?? 0] || "?",
          src: v[0],
          from,
          to,
        });
      }
    }
    return out;
  }, [graph, positions]);

  const tempLink = (() => {
    if (!linkDrag) return null;
    if (linkDrag.mode === "out") {
      if (!positions[linkDrag.fromId]) return null;
      const from = outAt(linkDrag.fromId, positions[linkDrag.fromId], linkDrag.outIdx);
      return linkPath(from, { x: linkDrag.mx, y: linkDrag.my });
    }
    if (!positions[linkDrag.toId]) return null;
    const rows = rowsOf(linkDrag.toId);
    const i = rows.findIndex((r) => r.key === linkDrag.toKey);
    const to = inAnchor(positions[linkDrag.toId], Math.max(0, i));
    return linkPath({ x: linkDrag.mx, y: linkDrag.my }, to);
  })();

  /* ------------------------- 结构编辑 ------------------------- */

  const viewCenter = (): Pos => {
    const rect = containerRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (rect?.width ?? 800) / 2 / v.k - v.x / v.k - NODE_W / 2,
      y: (rect?.height ?? 520) / 2 / v.k - v.y / v.k - 70,
    };
  };

  const addNode = (classType: string, at?: Pos) => {
    const res = applyGraphOps(graph, [{ op: "add", class_type: classType }], opsCtx);
    if (res.errors.length) {
      flash(res.errors[0]);
      return;
    }
    const newId = Object.keys(res.graph).find((id) => !graph[id]);
    onGraphChange(res.graph);
    if (newId) {
      const p = at ?? viewCenter();
      setPositions((s) => ({ ...s, [newId]: { x: snapGrid(p.x), y: snapGrid(p.y) } }));
      setSelIds([newId]);
      setSelLink(null);
    }
    setPicker(null);
    setPickerQuery("");
  };

  const removeNodes = (ids: string[]) => {
    if (!ids.length) return;
    const res = applyGraphOps(
      graph,
      ids.map((id) => ({ op: "remove" as const, id })),
      opsCtx
    );
    setSelIds([]);
    setSelLink(null);
    onGraphChange(res.graph);
  };

  const cloneNode = (id: string) => {
    const node = graph[id];
    if (!node) return;
    const nums = Object.keys(graph)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n));
    const newId = String((nums.length ? Math.max(...nums) : 0) + 1);
    const copy = JSON.parse(JSON.stringify(node));
    // 复制时把连线也一起复制（指向同一上游），跟 ComfyUI 的 clone 一致
    mutateDraft((g) => {
      g[newId] = copy;
      g[newId]._meta = { title: `${node._meta?.title || node.class_type} 副本`.slice(0, 40) };
    });
    setPositions((s) => ({
      ...s,
      [newId]: { x: (s[id]?.x ?? 0) + 32, y: (s[id]?.y ?? 0) + 32 },
    }));
    setSelIds([newId]);
    flash(`已复制为 #${newId}`);
  };

  const disconnectAll = (id: string) => {
    mutateDraft((g) => {
      for (const [k, v] of Object.entries(g[id].inputs || {})) {
        if (Array.isArray(v)) delete g[id].inputs[k];
      }
      for (const node of Object.values(g)) {
        for (const [k, v] of Object.entries(node.inputs)) {
          if (Array.isArray(v) && v[0] === id) delete node.inputs[k];
        }
      }
    });
    flash("已断开这个节点的全部连线");
  };

  const relayout = () => {
    fitPending.current = true;
    setPositions(layout.positions);
    flash("已按数据流重新分层");
  };

  /* ------------------------- 键盘 ------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

      if (e.key === "Escape") {
        setMenu(null);
        setPicker(null);
        setSelIds([]);
        setSelLink(null);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && editing) {
        if (selLink) {
          detach(selLink.id, selLink.key);
          setSelLink(null);
          e.preventDefault();
          return;
        }
        if (selIds.length) {
          removeNodes(selIds);
          e.preventDefault();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelIds(Object.keys(graph));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && selIds.length) {
        e.preventDefault();
        cloneNode(selIds[selIds.length - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, selIds, selLink, graph]);

  const run = () => {
    if (busy) return;
    onRun();
  };

  const pickerResults = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const pool = NODES.filter((n) => !n.c.startsWith("partner/"));
    const hits = q
      ? pool.filter(
          (n) =>
            n.n.toLowerCase().includes(q) ||
            n.d.toLowerCase().includes(q) ||
            n.c.toLowerCase().includes(q)
        )
      : pool;
    return hits.slice(0, 40);
  }, [pickerQuery]);

  const openPickerAt = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const p = screenToContent(clientX, clientY);
    setPicker({
      at: { x: p.x - NODE_W / 2, y: p.y - HEADER_H / 2 },
      sx: clamp(clientX - (rect?.left ?? 0), 8, Math.max(8, (rect?.width ?? 600) - 320)),
      sy: clamp(clientY - (rect?.top ?? 0), 8, Math.max(8, (rect?.height ?? 480) - 300)),
    });
    setPickerQuery("");
    setMenu(null);
  };

  const onCanvasDoubleClick = (e: React.MouseEvent) => {
    if (!editing) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-node]")) return;
    openPickerAt(e.clientX, e.clientY);
  };

  const onCanvasContext = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!editing) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-node]")) return;
    const local = localXY(e.clientX, e.clientY);
    setPicker(null);
    setMenu({ kind: "canvas", x: local.x, y: local.y });
  };

  /* ------------------------- 渲染 ------------------------- */

  const nodes = Object.entries(graph);
  const dragType = linkDrag
    ? linkDrag.mode === "out"
      ? linkDrag.outType
      : linkDrag.inType
    : null;
  const draggingMode = linkDrag?.mode ?? null;

  return (
    <div className="space-y-2.5">
      <div className="no-select flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-[12px] bg-[var(--bg-1)] px-3 py-2 shadow-[inset_0_0_0_0.5px_var(--line-1)]">
        <Tag
          tone={
            doc.status === "done"
              ? "ok"
              : doc.status === "error"
                ? "err"
                : doc.status === "running"
                  ? "accent"
                  : "quiet"
          }
        >
          {doc.status === "done"
            ? "已生成"
            : doc.status === "running"
              ? "生成中"
              : doc.status === "error"
                ? "上次失败"
                : "待生成"}
        </Tag>
        <span className="t-11 tabular text-[var(--fg-3)]">{nodes.length} 节点</span>
        {revealTotal && revealedNow < revealTotal ? (
          <span className="flex items-center gap-1 t-11 tabular text-[var(--accent)] fade-in">
            铺节点 {revealedNow}/{revealTotal}
          </span>
        ) : null}
        {doc.fromAI ? (
          <button
            onClick={() => setShowChange((v) => !v)}
            className="flex items-center gap-1 t-11 text-[var(--accent)] transition-opacity hover:opacity-80"
            title="点一下看 AI 到底动了哪几个节点、哪几根线"
          >
            {doc.rebuild ? "AI 重铺了整版" : "AI 刚改过"}
            {doc.change && doc.change.total > 0 ? (
              <span className="tabular text-[var(--fg-4)]">
                · {doc.rebuild ? `整版 ${doc.rebuild.after} 节点` : diffSummary(doc.change)}
              </span>
            ) : null}
          </button>
        ) : null}
        {busy ? (
          <span className="flex min-w-0 items-center gap-1.5 t-11 text-[var(--accent)]">
            <Spinner className="size-2.5" />
            <span className="truncate">
              {runNow
                ? `跑 ${graph[runNow]?._meta?.title || `#${runNow}`}${
                    runNodes?.[runNow]?.pct != null
                      ? ` · ${Math.round((runNodes[runNow].pct ?? 0) * 100)}%`
                      : ""
                  }`
                : stage || "正在改画布"}
            </span>
          </span>
        ) : doc.note ? (
          <span className="max-w-[300px] truncate t-11 text-[var(--fg-4)]">{doc.note}</span>
        ) : null}

        <div className="flex-1" />
        {selIds.length ? (
          <Btn
            size="xs"
            variant="ghost"
            className="hover:text-[var(--err)]"
            onClick={() => removeNodes(selIds)}
            disabled={busy}
            title="删除所选节点，并清理指向它的连线"
          >
            删除{selIds.length > 1 ? ` ${selIds.length}` : ""}
          </Btn>
        ) : null}
        <Btn
          size="xs"
          variant="ghost"
          onClick={onReset}
          disabled={busy || !baseGraph}
          title="丢掉画布上的改动，回到最近一次生成出来的那张图"
        >
          还原
        </Btn>
        {/* 动作区跟前半段的"状态/信息"分开，别让一排东西糊在一起 */}
        <span className="mx-1 h-4 w-px bg-[var(--line-2)]" />
        {busy ? (
          <Btn
            size="xs"
            variant="outline"
            onClick={() => onCancel?.()}
            title="断开引擎，停止这次生成"
          >
            停止
          </Btn>
        ) : (
          <Btn
            size="xs"
            variant="accent"
            onClick={run}
            disabled={Object.keys(doc.graph).length === 0}
            title={Object.keys(doc.graph).length === 0 ? "画布还是空的，先加节点再生成" : "按画布上这张图执行，这就是唯一的生成入口"}
            icon={I.play(10)}
          >
            开始生成
          </Btn>
        )}
      </div>

      {hint ? <div className="t-11 text-[var(--fg-3)] fade-in">{hint}</div> : null}

      <div
        ref={containerRef}
        onPointerDown={onCanvasDown}
        onDoubleClick={onCanvasDoubleClick}
        onContextMenu={onCanvasContext}
        className={cx(
          "relative select-none overflow-hidden rounded-[14px] bg-[var(--bg-base)] shadow-[inset_0_0_0_0.5px_var(--line-2)]",
          spaceHeld ? "cursor-grab" : "cursor-default"
        )}
        style={{
          height: "clamp(460px, calc(100vh - 268px), 1400px)",
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.055) 1px, transparent 0)",
          backgroundSize: `${22 * view.k}px ${22 * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        {/* 空画布引导：一张白板最吓人，把第一批动作直接告诉人 */}
        {!nodes.length ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="text-center fade-in">
              <div className="mx-auto mb-3 grid size-11 place-items-center rounded-[14px] bg-[var(--bg-2)] text-[var(--fg-3)] shadow-[inset_0_0_0_0.5px_var(--line-2)]">
                {I.node(18)}
              </div>
              <div className="t-13 text-[var(--fg-2)]">空画布</div>
              <div className="mx-auto mt-1.5 max-w-[380px] t-12 leading-[19px] text-[var(--fg-4)]">
                在左边说一句想拍的东西，图会搭到这里；想自己动手也行——双击空白处加节点，拖端口连线。
              </div>
            </div>
          </div>
        ) : null}
        {/* 变换层：节点（HTML）和连线（SVG）共用一套坐标 */}
        <div
          className="absolute left-0 top-0"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
            transformOrigin: "0 0",
          }}
        >
          <svg
            width={Math.max(layout.width, 4000)}
            height={Math.max(layout.height, 3000)}
            style={{ overflow: "visible", pointerEvents: "none" }}
            className="absolute left-0 top-0"
          >
            {links.map((l) => {
              const isSel = selLink?.id === l.id && selLink?.key === l.field;
              // 铺图动画：两端还没"长出来"，线也别先冒出来
              const stillHidden = hiddenIds.has(l.id) || hiddenIds.has(l.src);
              return (
                <g
                  key={l.key}
                  style={{
                    opacity: stillHidden ? 0 : 1,
                    transition: "opacity 160ms ease-out",
                  }}
                >
                  <path
                    d={l.d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                    style={{ pointerEvents: "stroke", cursor: "pointer" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelLink({ id: l.id, key: l.field });
                      setSelIds([]);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setSelLink({ id: l.id, key: l.field });
                      const local = localXY(e.clientX, e.clientY);
                      setMenu({ kind: "link", x: local.x, y: local.y, id: l.id, key: l.field });
                    }}
                  />
                  <path
                    d={l.d}
                    fill="none"
                    stroke={isSel ? "#ffffff" : slotColor(l.type)}
                    strokeWidth={isSel ? 2.8 : 1.7}
                    strokeLinecap="round"
                    opacity={isSel ? 1 : 0.8}
                    style={{ pointerEvents: "none" }}
                  />
                </g>
              );
            })}

            {tempLink ? (
              <path
                d={tempLink}
                fill="none"
                stroke={snap ? "#ffffff" : slotColor(dragType || undefined)}
                strokeWidth={snap ? 2.6 : 1.7}
                strokeDasharray={snap ? undefined : "5 4"}
                strokeLinecap="round"
                style={{ pointerEvents: "none" }}
              />
            ) : null}

            {/* 吸附时在落点画一圈，明确告诉人"松手就连这里" */}
            {snap ? (
              <circle
                cx={snap.at.x}
                cy={snap.at.y}
                r={9}
                fill="none"
                stroke="#ffffff"
                strokeWidth={1.4}
                opacity={0.85}
                style={{ pointerEvents: "none" }}
              />
            ) : null}
          </svg>

          {nodes.map(([id, node]) => {
            const p = positions[id];
            if (!p) return null;
            const card = cardOf(node.class_type);
            const outList = outTypes(node.class_type);
            const rows = rowsOf(id);
            const isSel = selIds.includes(id);
            const edited =
              !!baseGraph && JSON.stringify(node) !== JSON.stringify(baseGraph[id]);
            const h = hOf(id);
            // 生成中的实时状态：跑到这个节点就亮起来，跑完打勾
            const run = runNodes?.[id];
            const running = run?.s === "run";
            const runPct = Math.round((run?.pct ?? 0) * 100);
            // AI 铺图动画里还没轮到它
            const notYet = hiddenIds.has(id);

            return (
              <div
                key={id}
                data-node
                onPointerDown={(e) => startNodeDrag(e, id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!editing) return;
                  setSelLink(null);
                  if (!selIds.includes(id)) setSelIds([id]);
                  const local = localXY(e.clientX, e.clientY);
                  setMenu({ kind: "node", x: local.x, y: local.y, id });
                }}
                style={{ left: p.x, top: p.y, width: NODE_W, height: h }}
                className={cx(
                  "group no-select absolute rounded-[10px] bg-[var(--bg-2)]",
                  isSel
                    ? "shadow-[inset_0_0_0_1.5px_var(--accent-dim),0_14px_30px_-12px_rgba(0,0,0,0.95)]"
                    : "shadow-[inset_0_0_0_0.5px_var(--line-2),0_10px_24px_-14px_rgba(0,0,0,0.9)] hover:shadow-[inset_0_0_0_0.5px_var(--line-3),0_12px_26px_-12px_rgba(0,0,0,0.95)]",
                  // AI 刚碰过的节点：亮一下，让人知道它动了哪儿
                  flashIds.has(id) && "ai-touch",
                  // 铺图动画：还没轮到的先隐身，一个个长出来。
                  // 隐身时不加过渡——否则挂载那一帧会先从 1 淡到 0，看着像闪一下
                  notYet && "pointer-events-none opacity-0",
                  !notYet && "transition-opacity duration-200",
                  editing ? "cursor-move" : "cursor-default"
                )}
              >
                <div
                  className="flex items-center justify-between gap-2 px-2.5"
                  style={{ height: HEADER_H }}
                >
                  <span className="truncate t-12 text-[var(--fg-1)]">
                    {node._meta?.title || node.class_type}
                    {running ? (
                      <span className="ml-1 rounded-[3px] bg-[var(--accent-soft)] px-1 py-[1px] text-[10px] leading-[13px] tabular text-[var(--accent)]">
                        {runPct}%
                      </span>
                    ) : run?.s === "done" ? (
                      <span className="ml-1 text-[var(--ok)]">✓</span>
                    ) : run?.s === "cache" ? (
                      <span className="ml-1 rounded-[3px] bg-[var(--bg-3)] px-1 py-[1px] text-[10px] leading-[13px] text-[var(--fg-4)]">
                        缓存
                      </span>
                    ) : run?.s === "err" ? (
                      <span className="ml-1 rounded-[3px] bg-[var(--err-soft,rgba(220,80,80,0.16))] px-1 py-[1px] text-[10px] leading-[13px] text-[var(--err)]">
                        出错
                      </span>
                    ) : flashIds.has(id) ? (
                      <span className="ml-1 rounded-[3px] bg-[var(--accent-soft)] px-1 py-[1px] text-[10px] leading-[13px] text-[var(--accent)]">
                        AI 改
                      </span>
                    ) : edited ? (
                      <span className="ml-1 text-[var(--accent)]">•</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 t-11 font-mono text-[var(--fg-4)]">#{id}</span>
                </div>

                {/* 正在跑：给一圈亮边，让人一眼看到现在轮到哪个节点 */}
                {running ? (
                  <div
                    className="pointer-events-none absolute inset-0 rounded-[10px]"
                    style={{ boxShadow: "inset 0 0 0 1.5px var(--accent)" }}
                  />
                ) : run?.s === "err" ? (
                  <div
                    className="pointer-events-none absolute inset-0 rounded-[10px]"
                    style={{ boxShadow: "inset 0 0 0 1.5px var(--err)" }}
                  />
                ) : null}
                {running ? (
                  <div className="pointer-events-none absolute inset-x-2 bottom-[5px] h-[2px] overflow-hidden rounded-full bg-[var(--line-2)]">
                    <div
                      className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-200"
                      style={{ width: `${Math.max(4, runPct)}%` }}
                    />
                  </div>
                ) : null}

                <div className="px-2.5">
                  {rows.map((row, i) => {
                    const key = row.key;
                    const v = (node.inputs as any)[key];
                    const linked = Array.isArray(v);
                    const present = key in (node.inputs || {});
                    const eligible = inputEligible(node.class_type, key);
                    const t = row.spec?.t;
                    const compatible = draggingMode === "out" ? typeMatch(dragType!, t) : true;
                    const snapped =
                      snap?.side === "in" && snap.id === id && snap.key === key;
                    return (
                      <div key={key} className="relative flex items-center" style={{ height: ROW_H }}>
                        {eligible ? (
                          <span
                            data-port="in"
                            data-id={id}
                            data-key={key}
                            data-eligible="1"
                            onPointerDown={(e) => startLinkFromIn(e, id, key)}
                            title={
                              linked
                                ? "拖走以改接，或拖到别的输出上"
                                : "拖到某个输出上建立连线"
                            }
                            style={{
                              left: -15,
                              top: ROW_H / 2 - 7,
                              borderColor: linked ? slotColor(t) : undefined,
                              background: linked ? slotColor(t) : undefined,
                            }}
                            className={cx(
                              "absolute grid size-[14px] place-items-center rounded-full cursor-crosshair transition-transform",
                              linked ? "opacity-100" : "bg-[var(--bg-base)]",
                              !linked && (present ? "border-[1.5px]" : "border-[1.5px]"),
                              !linked && present && "border-[var(--fg-4)]",
                              !linked && !present && "border-[var(--line-3)]",
                              snapped && "scale-[1.45] ring-2 ring-white/70",
                              draggingMode === "out" && !compatible && "opacity-25"
                            )}
                          >
                            {linked ? (
                              <span className="size-[6px] rounded-full bg-[#0b0b0d]/70" />
                            ) : null}
                          </span>
                        ) : null}
                        <span className="truncate pr-1 t-11 font-mono text-[var(--fg-3)]">
                          {linked ? (
                            <>
                              {key}{" "}
                              <span style={{ color: slotColor(t) }}>
                                ← #{v[0]}[{v[1]}]
                              </span>
                            </>
                          ) : present ? (
                            <>
                              {key}:{" "}
                              <span className="text-[var(--fg-2)]">{String(v).slice(0, 14)}</span>
                            </>
                          ) : (
                            <span className="text-[var(--fg-4)]">{key} · 未连接</span>
                          )}
                        </span>
                        {editing && linked && eligible ? (
                          <button
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              detach(id, key);
                            }}
                            title="断开连线"
                            className="ml-auto shrink-0 px-0.5 t-11 leading-none text-[var(--fg-4)] transition-colors hover:text-[var(--err)]"
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
                    );
                  })}

                  {/* 可选输入收起来：一张卡摊开 14 行，多镜图就什么都看不见了 */}
                  {(() => {
                    const opts = optOf(id);
                    if (!opts.length) return null;
                    const open = expanded.has(id);
                    return (
                      <button
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(id);
                        }}
                        title={
                          open ? "收起可选输入" : `点开可看可接：${opts.join(" / ")}`
                        }
                        className={cx(
                          "flex w-full items-center gap-1 t-11 transition-colors",
                          open
                            ? "text-[var(--fg-3)] hover:text-[var(--fg-1)]"
                            : "text-[var(--fg-4)] hover:text-[var(--fg-2)]"
                        )}
                        style={{ height: ROW_H }}
                      >
                        <span className="font-mono leading-none">{open ? "−" : "＋"}</span>
                        <span className="truncate">
                          {open ? "收起可选" : `${opts.length} 可选`}
                        </span>
                      </button>
                    );
                  })()}
                </div>

                {outList.length ? (
                  <div
                    className={cx(
                      "px-2.5 pt-1",
                      rows.length ? "shadow-[inset_0_0.5px_0_var(--line-1)]" : ""
                    )}
                  >
                    {outList.map((t, j) => {
                      const snapped = snap?.side === "out" && snap.id === id && snap.idx === j;
                      const compatible = draggingMode === "in" ? typeMatch(t, dragType!) : true;
                      return (
                        <div
                          key={j}
                          className="relative flex items-center justify-end gap-1"
                          style={{ height: ROW_H }}
                        >
                          <span className="t-11 font-mono" style={{ color: slotColor(t) }}>
                            {t}
                          </span>
                          <span
                            data-port="out"
                            data-id={id}
                            data-idx={j}
                            onPointerDown={(e) => startLinkFromOut(e, id, j)}
                            title="拖到某个输入上建立连线"
                            style={{
                              right: -15,
                              top: ROW_H / 2 - 7,
                              background: slotColor(t),
                              borderColor: slotColor(t),
                            }}
                            className={cx(
                              "absolute size-[14px] cursor-crosshair rounded-full border-[1.5px] transition-transform",
                              snapped && "scale-[1.45] ring-2 ring-white/70",
                              draggingMode === "in" && !compatible && "opacity-25"
                            )}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {!rows.length && !outList.length ? (
                  <div className="px-2.5 pb-2 t-11 text-[var(--fg-4)]">{node.class_type}</div>
                ) : null}
                {!card ? (
                  <div className="px-2.5 pb-1.5 t-11 text-[var(--warn)]">未知类型</div>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* 框选：画在屏幕层，不受缩放影响 */}
        {marquee ? (
          <div
            className="pointer-events-none absolute border border-[var(--accent-dim)] bg-[var(--accent-soft)]"
            style={{
              left: marquee.x0 * view.k + view.x,
              top: marquee.y0 * view.k + view.y,
              width: (marquee.x1 - marquee.x0) * view.k,
              height: (marquee.y1 - marquee.y0) * view.k,
            }}
          />
        ) : null}

        {/* 左下操作提示：改动清单摊开时让位，别叠在一起 */}
        <div
          className={cx(
            "no-select pointer-events-none absolute bottom-2.5 left-3.5 t-11 text-[var(--fg-4)]",
            showChange && doc.change && doc.change.total > 0 && "opacity-0"
          )}
        >
          {editing
            ? "滚轮缩放 · 空白拖动平移 · 双击加节点 · 右键菜单 · 拖端口连线"
            : "点「编辑画布」进入共编模式"}
        </div>

        {/* AI 改动清单：动了哪几个节点、哪几根线，点一条就飞过去 */}
        {showChange && doc.change && doc.change.total > 0 ? (
          <div className="no-select absolute bottom-8 left-3 z-20 w-[248px] rounded-[10px] bg-[var(--bg-1)]/95 shadow-[inset_0_0_0_0.5px_var(--line-2),0_16px_36px_-16px_rgba(0,0,0,0.9)] backdrop-blur">
            <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1.5">
              <span className="size-1.5 rounded-full bg-[var(--accent)]" />
              <span className="t-11 text-[var(--fg-2)]">
                {doc.rebuild ? "AI 重铺了整张图" : "AI 改了什么"}
              </span>
              <div className="flex-1" />
              <span className="t-11 tabular text-[var(--fg-4)]">
                {doc.rebuild
                  ? `旧 ${doc.rebuild.before} → 新 ${doc.rebuild.after} 节点`
                  : diffSummary(doc.change)}
              </span>
              <button
                onClick={() => setShowChange(false)}
                className="ml-0.5 grid size-4 place-items-center rounded-[4px] text-[var(--fg-4)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg-1)]"
                title="收起"
              >
                {I.close(10)}
              </button>
            </div>
            {doc.rebuild ? (
              <div className="px-2.5 pb-1.5 t-11 leading-[15px] text-[var(--fg-4)]">
                重新编译分镜时节点编号撞上了旧版，等于整版换掉——下面这些全是新铺的。
              </div>
            ) : null}
            <div className="max-h-[124px] overflow-y-auto px-1.5 pb-1.5">
              {/* 铺图动画期间，清单跟着节点一起长出来，别一次全列完 */}
              {(revealTotal && revealedNow < revealTotal
                ? doc.change.added.slice(0, revealedNow)
                : doc.change.added
              ).map((a) => (
                <button
                  key={`a-${a.id}`}
                  onClick={() => onFocusNode?.(a.id)}
                  className="flex w-full items-center gap-1.5 rounded-[5px] px-1.5 py-[3px] text-left transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <span className="shrink-0 text-[var(--ok)]">＋</span>
                  <span className="truncate t-11 text-[var(--fg-2)]">{a.title}</span>
                </button>
              ))}
              {doc.change.changed.map((c) => (
                <button
                  key={`c-${c.id}`}
                  onClick={() => onFocusNode?.(c.id)}
                  className="flex w-full items-center gap-1.5 rounded-[5px] px-1.5 py-[3px] text-left transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <span className="shrink-0 text-[var(--accent)]">{doc.rebuild ? "↻" : "·"}</span>
                  <span className="truncate t-11 text-[var(--fg-2)]">{c.title}</span>
                  {/* 整版重铺时列"改了哪几个参数"没意义：每个节点都是新铺的 */}
                  {doc.rebuild ? null : (
                    <span className="ml-auto shrink-0 truncate t-11 text-[var(--fg-4)]">
                      {c.keys.slice(0, 2).join(" / ")}
                    </span>
                  )}
                </button>
              ))}
              {doc.change.removed.map((r) => (
                <div key={`r-${r.id}`} className="flex items-center gap-1.5 px-1.5 py-[3px] opacity-60">
                  <span className="shrink-0 text-[var(--err)]">－</span>
                  <span className="truncate t-11 text-[var(--fg-3)] line-through">{r.title}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* 参数检查器：选中的节点在画布右上角就地改，不挤占画布高度 */}
        {selIds.length === 1 ? (
          <div className="no-select absolute right-2 top-2 z-20 flex max-h-[calc(100%-44px)] w-[300px] flex-col overflow-hidden rounded-[12px] bg-[var(--bg-2)]/95 shadow-[inset_0_0_0_0.5px_var(--line-2),0_18px_44px_-16px_rgba(0,0,0,0.85)] backdrop-blur">
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
              <span className="truncate t-13 text-[var(--fg-1)]">
                {graph[selIds[0]]?._meta?.title || selIds[0]}
              </span>
              <span className="shrink-0 t-11 font-mono text-[var(--fg-4)]">
                #{selIds[0]}
              </span>
              <div className="flex-1" />
              <button
                onClick={() => setSelIds([])}
                className="grid size-5 shrink-0 place-items-center rounded-[5px] text-[var(--fg-4)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg-1)]"
                title="收起"
              >
                {I.close(11)}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto border-t-[0.5px] border-[var(--line-1)] px-3 py-2.5">
              <ParamEditor
                graph={graph}
                nodeId={selIds[0]}
                onChange={(key, value) => setParam(selIds[0], key, value)}
              />
            </div>
            <div className="shrink-0 border-t-[0.5px] border-[var(--line-1)] px-3 py-2 t-11 text-[var(--fg-4)]">
              连线在画布上拖端口；改完点上方「开始生成」
            </div>
          </div>
        ) : null}

        {/* 右下缩放控件 */}
        <div className="no-select absolute bottom-2 right-2 flex items-center gap-0.5 rounded-[9px] bg-[var(--bg-1)]/90 p-0.5 shadow-[inset_0_0_0_0.5px_var(--line-2)] backdrop-blur">
          <button
            onClick={() => {
              const rect = containerRef.current?.getBoundingClientRect();
              zoomBy(1 / 1.2, (rect?.width ?? 600) / 2, (rect?.height ?? 400) / 2);
            }}
            className="grid size-6 place-items-center rounded-[6px] t-13 text-[var(--fg-3)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg-1)]"
            title="缩小"
          >
            −
          </button>
          <button
            onClick={() => setView({ x: 0, y: 0, k: 1 })}
            className="min-w-[42px] rounded-[6px] px-1 t-11 tabular text-[var(--fg-3)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg-1)]"
            title="复位到 100%"
          >
            {Math.round(view.k * 100)}%
          </button>
          <button
            onClick={() => {
              const rect = containerRef.current?.getBoundingClientRect();
              zoomBy(1.2, (rect?.width ?? 600) / 2, (rect?.height ?? 400) / 2);
            }}
            className="grid size-6 place-items-center rounded-[6px] t-13 text-[var(--fg-3)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg-1)]"
            title="放大"
          >
            +
          </button>
          <button
            onClick={fitView}
            className="grid size-6 place-items-center rounded-[6px] text-[var(--fg-3)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg-1)]"
            title="适应画布"
          >
            {I.film(12)}
          </button>
        </div>

        {/* 右键菜单 */}
        {menu ? (
          <>
            <div
              className="fixed inset-0 z-30"
              onPointerDown={() => setMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu(null);
              }}
            />
            <div
              className="popover absolute z-40 w-[196px] p-1"
              style={{
                left: clamp(menu.x, 4, Math.max(4, (containerRef.current?.clientWidth ?? 600) - 204)),
                top: clamp(menu.y, 4, Math.max(4, (containerRef.current?.clientHeight ?? 400) - 210)),
              }}
              onContextMenu={(e) => e.preventDefault()}
            >
              {menu.kind === "canvas" ? (
                <>
                  <MenuItem
                    label="添加节点…"
                    hint="双击空白也行"
                    onClick={() => {
                      const rect = containerRef.current?.getBoundingClientRect();
                      openPickerAt((rect?.left ?? 0) + menu.x, (rect?.top ?? 0) + menu.y);
                    }}
                  />
                  <MenuItem label="全选" hint="Ctrl+A" onClick={() => setSelIds(Object.keys(graph))} />
                  <MenuItem label="适应画布" onClick={fitView} />
                  <MenuItem label="按数据流重排" onClick={relayout} />
                </>
              ) : null}

              {menu.kind === "node" ? (
                <>
                  <MenuItem
                    label="复制节点"
                    hint="Ctrl+D"
                    onClick={() => {
                      setMenu(null);
                      cloneNode(menu.id);
                    }}
                  />
                  <MenuItem
                    label="断开全部连线"
                    onClick={() => {
                      setMenu(null);
                      disconnectAll(menu.id);
                    }}
                  />
                  <div className="my-1 h-[0.5px] bg-[var(--line-2)]" />
                  <MenuItem
                    label={selIds.length > 1 ? `删除 ${selIds.length} 个节点` : "删除节点"}
                    hint="Del"
                    danger
                    onClick={() => {
                      setMenu(null);
                      removeNodes(selIds.length ? selIds : [menu.id]);
                    }}
                  />
                </>
              ) : null}

              {menu.kind === "link" ? (
                <MenuItem
                  label="删除这条连线"
                  hint="Del"
                  danger
                  onClick={() => {
                    detach(menu.id, menu.key);
                    setSelLink(null);
                    setMenu(null);
                  }}
                />
              ) : null}
            </div>
          </>
        ) : null}

        {/* 双击 / 右键弹出的节点搜索 */}
        {picker ? (
          <>
            <div
              className="fixed inset-0 z-30"
              onPointerDown={() => {
                setPicker(null);
                setPickerQuery("");
              }}
            />
            <div
              className="popover absolute z-40 w-[312px] p-2"
              style={{ left: picker.sx, top: picker.sy }}
            >
              <input
                autoFocus
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && pickerResults[0]) addNode(pickerResults[0].n, picker.at);
                  if (e.key === "Escape") setPicker(null);
                }}
                placeholder={`搜索 ${NODES.length} 个可执行节点，回车加第一个`}
                className="field h-[30px] text-[12px]"
              />
              <div className="mt-1.5 max-h-[240px] space-y-px overflow-y-auto">
                {pickerResults.map((n) => (
                  <button
                    key={n.n}
                    onClick={() => addNode(n.n, picker.at)}
                    className="flex w-full items-center justify-between gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                  >
                    <span className="min-w-0 truncate">
                      <span className="t-12 text-[var(--fg-1)]">{n.d}</span>
                      <span className="ml-1.5 t-11 font-mono text-[var(--fg-4)]">{n.n}</span>
                    </span>
                    <span className="shrink-0 t-11 text-[var(--fg-4)]">{n.c}</span>
                  </button>
                ))}
                {!pickerResults.length ? (
                  <div className="py-3 text-center t-11 text-[var(--fg-4)]">
                    没有匹配的可执行节点（需本地权重的节点不在列表里）
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </div>

    </div>
  );
}

function MenuItem({
  label,
  hint,
  danger,
  onClick,
}: {
  label: string;
  hint?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-2 rounded-[6px] px-2 py-[6px] text-left transition-colors",
        danger
          ? "text-[var(--err)] hover:bg-[rgba(224,112,112,0.12)]"
          : "text-[var(--fg-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg-1)]"
      )}
    >
      <span className="flex-1 truncate t-12">{label}</span>
      {hint ? <span className="shrink-0 t-11 text-[var(--fg-4)]">{hint}</span> : null}
    </button>
  );
}
