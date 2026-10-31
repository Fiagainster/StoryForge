/**
 * 画布审计：两件跟"AI 到底改了什么、改完能不能跑"有关的事。
 *
 * 1. diffGraph —— AI 动完手，得让人一眼看出动了哪几个节点、连了几根线。
 * 2. auditGraph —— 交出图之前先问一句"这玩意儿真能跑吗"：
 *    必填输入有没有接上、终点在不在、有没有悬空孤岛、有没有引用断了。
 *    不能跑的图不许当成"做好了"交给人。
 */
import { BLOCKED_INDEX, NODE_INDEX } from "./nodeSearch";
import type { LibInput } from "./nodeSearch";
import type { ComfyGraph } from "../types";

/* --------------------------- 图差异 --------------------------- */

export interface NodeChange {
  id: string;
  title: string;
  /** 变了哪些字段（参数名 / 连线名） */
  keys: string[];
}

export interface GraphDiff {
  added: { id: string; title: string }[];
  removed: { id: string; title: string }[];
  changed: NodeChange[];
  linksAdded: number;
  linksRemoved: number;
  /** 有效改动条数：节点增删改各算 1，连线按根算 */
  total: number;
}

const titleOf = (graph: ComfyGraph, id: string) =>
  graph[id]?._meta?.title || NODE_INDEX.get(graph[id]?.class_type || "")?.d || `${id}`;

const linksOf = (graph: ComfyGraph): Set<string> => {
  const set = new Set<string>();
  for (const [id, node] of Object.entries(graph || {})) {
    for (const [key, v] of Object.entries<any>(node?.inputs || {})) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string") {
        set.add(`${id}.${key}←${v[0]}#${v[1]}`);
      }
    }
  }
  return set;
};

export function diffGraph(before: ComfyGraph, after: ComfyGraph): GraphDiff {
  const added: GraphDiff["added"] = [];
  const removed: GraphDiff["removed"] = [];
  const changed: NodeChange[] = [];

  for (const id of Object.keys(after || {})) {
    if (!before?.[id]) added.push({ id, title: titleOf(after, id) });
  }
  for (const id of Object.keys(before || {})) {
    if (!after?.[id]) removed.push({ id, title: titleOf(before, id) });
  }
  for (const id of Object.keys(after || {})) {
    const a = before?.[id];
    const b = after[id];
    if (!a || !b) continue;
    const keys: string[] = [];
    if (a.class_type !== b.class_type) keys.push("类型");
    const ka = Object.keys(a.inputs || {});
    const kb = Object.keys(b.inputs || {});
    for (const k of new Set([...ka, ...kb])) {
      if (JSON.stringify(a.inputs?.[k]) !== JSON.stringify(b.inputs?.[k])) keys.push(k);
    }
    if (a._meta?.title !== b._meta?.title) keys.push("标题");
    if (keys.length) changed.push({ id, title: titleOf(after, id), keys });
  }

  const la = linksOf(before || {});
  const lb = linksOf(after || {});
  let linksAdded = 0;
  let linksRemoved = 0;
  for (const k of lb) if (!la.has(k)) linksAdded++;
  for (const k of la) if (!lb.has(k)) linksRemoved++;

  return {
    added,
    removed,
    changed,
    linksAdded,
    linksRemoved,
    total: added.length + removed.length + changed.length + linksAdded + linksRemoved,
  };
}

export function diffSummary(d: GraphDiff): string {
  const bits: string[] = [];
  if (d.added.length) bits.push(`+${d.added.length} 节点`);
  if (d.removed.length) bits.push(`-${d.removed.length} 节点`);
  if (d.changed.length) bits.push(`改 ${d.changed.length} 处`);
  if (d.linksAdded) bits.push(`连线 +${d.linksAdded}`);
  if (d.linksRemoved) bits.push(`连线 -${d.linksRemoved}`);
  return bits.join(" · ") || "没有实质改动";
}

/** 改动涉及的节点 id（画布上要高亮这些） */
export function touchedIds(d: GraphDiff): string[] {
  return [
    ...d.added.map((x) => x.id),
    ...d.changed.map((x) => x.id),
    ...d.removed.map((x) => x.id),
  ];
}

/* --------------------------- 可运行性审计 --------------------------- */

export interface AuditIssue {
  level: "error" | "warn";
  /** 出问题的节点 id，画布上要指给人看 */
  id?: string;
  text: string;
}

const SCALARS = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
const SINK_TYPES = new Set(["SaveImage", "SaveVideo", "SaveAudio", "PreviewImage"]);

/** 所有连线指向的上游 id */
function upstreamOf(graph: ComfyGraph, id: string): string[] {
  const out: string[] = [];
  for (const v of Object.values<any>(graph[id]?.inputs || {})) {
    if (Array.isArray(v) && typeof v[0] === "string") out.push(v[0]);
  }
  return out;
}

function visibleTitle(graph: ComfyGraph, id: string): string {
  return graph[id]?._meta?.title
    ? `${id}「${graph[id]._meta!.title}」`
    : `${id}(${graph[id]?.class_type || "?"})`;
}

/** 节点卡查询：默认走节点库；测试时注入假卡，纯函数可离线跑 */
export interface AuditLookup {
  cardOf?: (classType: string) =>
    | { d?: string; in: LibInput[] }
    | undefined;
  blockedOf?: (classType: string) => { why: string[] } | undefined;
}

const httpish = (v: unknown): v is string =>
  typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim());

/**
 * 审计一张图能不能跑。
 * 只报"跑不起来"和"跑了也白跑"，不报风格问题——风格是人的事。
 */
export function auditGraph(graph: ComfyGraph, lookup?: AuditLookup): AuditIssue[] {
  const cardOf = lookup?.cardOf ?? ((ct: string) => NODE_INDEX.get(ct));
  const blockedOf = lookup?.blockedOf ?? ((ct: string) => BLOCKED_INDEX.get(ct));
  const issues: AuditIssue[] = [];
  const ids = Object.keys(graph || {});
  if (!ids.length) return [{ level: "error", text: "画布是空的，没有可执行的节点" }];

  const sinks = ids.filter((id) => SINK_TYPES.has(graph[id]?.class_type));

  for (const id of ids) {
    const node = graph[id];
    const card = cardOf(node.class_type);
    if (!card) {
      const blocked = blockedOf(node.class_type);
      issues.push({
        level: "error",
        id,
        text: blocked
          ? `${visibleTitle(graph, id)} 需要本地模型权重（${blocked.why[0] || "未安装"}），这台机器跑不了`
          : `${visibleTitle(graph, id)} 的类型 "${node.class_type}" 不存在`,
      });
      continue;
    }
    // 必填输入：要么接了线，要么自己有值
    for (const spec of card.in as LibInput[]) {
      if (spec.grow) continue;
      const has = spec.k in (node.inputs || {});
      if (has) continue;
      if (spec.req) {
        issues.push({
          level: "error",
          id,
          text: `${visibleTitle(graph, id)} 的必填输入 "${spec.k}"（${spec.t}）没接`,
        });
      }
    }
    // 引用了不存在的节点
    for (const [key, v] of Object.entries<any>(node.inputs || {})) {
      if (Array.isArray(v) && typeof v[0] === "string" && !graph[v[0]]) {
        issues.push({
          level: "error",
          id,
          text: `${visibleTitle(graph, id)} 的 "${key}" 指向已删除的节点 ${v[0]}`,
        });
      }
    }
    // 连线接在标量输入上 / 标量常量接在图像输入上
    for (const [key, v] of Object.entries<any>(node.inputs || {})) {
      const spec = (card.in as LibInput[]).find((s) => s.k === key);
      if (!spec || spec.grow || !spec.t) continue;
      if (SCALARS.has(spec.t) && Array.isArray(v)) {
        issues.push({
          level: "warn",
          id,
          text: `${visibleTitle(graph, id)} 的 "${key}" 是 ${spec.t}，接了一根线，执行器会忽略这个值`,
        });
        continue;
      }
      // 语义启发式：普通 STRING 字段里填了个 URL，多半是把该连线的东西写成了文件名/地址。
      // 静态结构查不出语义错，但这类"字段里躺着 URL"的错配抓得出来。
      if (spec.t === "STRING" && httpish(v) && !/url|link|endpoint/i.test(key)) {
        issues.push({
          level: "warn",
          id,
          text: `${visibleTitle(graph, id)} 的 "${key}" 里填的是一个网址（${String(v).slice(0, 60)}…）——多半应该用连线把上游接过来，而不是把 URL 写进这个字段`,
        });
      }
    }
  }

  if (!sinks.length) {
    issues.push({
      level: "error",
      text: "没有保存节点（SaveImage / SaveVideo）：跑完什么也不会留下",
    });
  }

  // 孤岛：从终点往上走不到的节点，就是白搭的
  if (sinks.length) {
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id) || !graph[id]) return;
      seen.add(id);
      for (const up of upstreamOf(graph, id)) walk(up);
    };
    sinks.forEach(walk);
    const lonely = ids.filter((id) => !seen.has(id));
    if (lonely.length) {
      issues.push({
        level: "warn",
        text: `${lonely.length} 个节点没接到产物上（${lonely
          .slice(0, 4)
          .map((id) => visibleTitle(graph, id))
          .join("、")}${lonely.length > 4 ? "…" : ""}），执行时会被跳过`,
      });
    }
  }

  return issues;
}

export const blockingIssues = (issues: AuditIssue[]) => issues.filter((i) => i.level === "error");

export function auditBrief(issues: AuditIssue[]): string {
  if (!issues.length) return "可执行";
  const errs = blockingIssues(issues);
  if (errs.length) return errs[0].text;
  return issues[0].text;
}

/** 图里有没有"真的会生成内容"的节点（调模型的），而不是只有占位画面 */
export function hasGenerator(graph: ComfyGraph): boolean {
  return Object.values(graph || {}).some((n) => {
    const ct = String(n?.class_type || "");
    if (ct.startsWith("Drama")) return true;
    return "model" in (n?.inputs || {});
  });
}
