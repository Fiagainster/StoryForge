import type { ComfyGraph } from "../types";

/* ------------------------------------------------------------------ *
 * 图操作引擎（一切皆操作）
 * 人（画布拖拽/添加/删除）和智能体（ops 协议）共用同一个引擎，
 * 两边产出同一种操作序列，应用逻辑与类型校验只有一份。
 * 纯函数：节点卡通过 ctx 注入，便于离线测试。
 * ------------------------------------------------------------------ */

export interface OpCard {
  display?: string;
  in: { k: string; t: string; def?: unknown; grow?: string; dyn?: number }[];
  out: string[];
}

export interface OpsCtx {
  cardOf: (classType: string) => OpCard | undefined;
}

export type GraphOp =
  | {
      op: "add";
      class_type: string;
      id?: string;
      title?: string;
      inputs?: Record<string, unknown>;
    }
  | { op: "remove"; id: string }
  | { op: "connect"; id: string; key: string; from: [string, number] }
  | { op: "disconnect"; id: string; key: string }
  | { op: "set"; id: string; key: string; value: unknown }
  | { op: "setMeta"; id: string; title: string };

export interface GraphOpsResult {
  graph: ComfyGraph;
  applied: string[];
  errors: string[];
}

function typeMatch(src: string | undefined, dst: string | undefined): boolean {
  if (!src || !dst) return false;
  return src === "*" || dst === "*" || src === dst;
}

export function applyGraphOps(
  base: ComfyGraph,
  ops: unknown,
  ctx: OpsCtx
): GraphOpsResult {
  const graph: ComfyGraph = JSON.parse(JSON.stringify(base ?? {}));
  const applied: string[] = [];
  const errors: string[] = [];

  const nextId = (): string => {
    let max = 0;
    for (const id of Object.keys(graph)) {
      const n = Number(id);
      if (Number.isInteger(n) && n > max) max = n;
    }
    return String(max + 1);
  };

  const list = Array.isArray(ops) ? ops : [];
  list.forEach((raw, i) => {
    const tag = `操作${i + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${tag}: 不是对象`);
      return;
    }
    const op = raw as GraphOp;

    switch (op.op) {
      case "add": {
        if (!op.class_type || typeof op.class_type !== "string") {
          errors.push(`${tag}: 缺少 class_type`);
          return;
        }
        const card = ctx.cardOf(op.class_type);
        if (!card) {
          errors.push(`${tag}: 未知节点类型 "${op.class_type}"`);
          return;
        }
        const id =
          typeof op.id === "string" && op.id.trim() ? op.id.trim() : nextId();
        if (graph[id]) {
          errors.push(`${tag}: 节点 ID "${id}" 已存在`);
          return;
        }
        const inputs: Record<string, unknown> = {};
        for (const spec of card.in) {
          if (spec.grow || spec.dyn) continue;
          if (spec.def !== undefined) inputs[spec.k] = spec.def;
        }
        if (op.inputs && typeof op.inputs === "object" && !Array.isArray(op.inputs)) {
          for (const [k, v] of Object.entries(op.inputs)) {
            if (Array.isArray(v)) {
              // 整条拒绝：带连线的 add 落一半在画布上比不加更糟
              errors.push(`${tag}: inputs.${k} 是连线，请用 connect 操作`);
              return;
            }
            inputs[k] = v;
          }
        }
        graph[id] = {
          class_type: op.class_type,
          inputs,
          _meta: { title: (op.title || card.display || op.class_type).slice(0, 40) },
        };
        applied.push(`加节点 ${id}(${op.class_type})`);
        return;
      }

      case "remove": {
        if (!graph[op.id]) {
          errors.push(`${tag}: 节点 ${op.id} 不存在`);
          return;
        }
        delete graph[op.id];
        for (const node of Object.values(graph)) {
          for (const [k, v] of Object.entries(node.inputs)) {
            if (Array.isArray(v) && v[0] === op.id) delete node.inputs[k];
          }
        }
        applied.push(`删节点 ${op.id}`);
        return;
      }

      case "connect": {
        const node = graph[op.id];
        if (!node) {
          errors.push(`${tag}: 节点 ${op.id} 不存在`);
          return;
        }
        const spec = ctx.cardOf(node.class_type)?.in.find((s) => s.k === op.key);
        if (!spec) {
          errors.push(`${tag}: ${op.id} 没有输入 "${op.key}"`);
          return;
        }
        const [fromId, outIdx] = Array.isArray(op.from)
          ? [op.from[0], Number(op.from[1])]
          : [undefined, NaN];
        const fromNode = fromId !== undefined ? graph[String(fromId)] : undefined;
        if (!fromNode) {
          errors.push(`${tag}: 来源节点 ${op.from?.[0]} 不存在`);
          return;
        }
        const outType = ctx.cardOf(fromNode.class_type)?.out?.[outIdx];
        if (outType === undefined) {
          errors.push(`${tag}: 来源 ${fromId} 的输出序号 ${op.from?.[1]} 越界`);
          return;
        }
        if (!typeMatch(outType, spec.t)) {
          errors.push(
            `${tag}: 类型不匹配，${op.id}.${op.key} 需要 ${spec.t}，来源输出是 ${outType}`
          );
          return;
        }
        node.inputs[op.key] = [String(fromId), outIdx];
        applied.push(`${op.id}.${op.key} ← ${fromId}[${outIdx}]`);
        return;
      }

      case "disconnect": {
        const node = graph[op.id];
        if (!node) {
          errors.push(`${tag}: 节点 ${op.id} 不存在`);
          return;
        }
        delete node.inputs[op.key];
        applied.push(`断开 ${op.id}.${op.key}`);
        return;
      }

      case "set": {
        const node = graph[op.id];
        if (!node) {
          errors.push(`${tag}: 节点 ${op.id} 不存在`);
          return;
        }
        if (Array.isArray(op.value)) {
          errors.push(`${tag}: set 只接受标量，连线请用 connect`);
          return;
        }
        const known =
          ctx.cardOf(node.class_type)?.in.some((s) => s.k === op.key) ||
          op.key in node.inputs;
        if (!known) {
          errors.push(`${tag}: ${op.id} 没有参数 "${op.key}"`);
          return;
        }
        node.inputs[op.key] = op.value;
        applied.push(`${op.id}.${op.key} = ${JSON.stringify(op.value)}`);
        return;
      }

      case "setMeta": {
        const node = graph[op.id];
        if (!node) {
          errors.push(`${tag}: 节点 ${op.id} 不存在`);
          return;
        }
        node._meta = { ...node._meta, title: String(op.title ?? "").slice(0, 40) };
        applied.push(`${op.id} 改名为 "${node._meta.title}"`);
        return;
      }

      default:
        errors.push(`${tag}: 未知操作 "${(op as any)?.op}"`);
    }
  });

  return { graph, applied, errors };
}

/* ------------------------------------------------------------------ *
 * 智能体画布共编提示词：给模型与人类同等的图编辑权
 * ------------------------------------------------------------------ */

export function buildGraphEditMessages(
  currentGraph: ComfyGraph,
  userText: string,
  catalog: string,
  lessons: string[]
): { role: "system" | "user"; content: string }[] {
  const lessonText = lessons.length
    ? `\n## 已沉淀的经验（务必规避）\n${lessons.map((l) => `- ${l}`).join("\n")}\n`
    : "";

  const system = `你是 StoryForge 画布上的共编智能体，对当前节点图拥有和人类用户完全一样的编辑权。通过一系列小操作直接修改图。

## 输出（严格 JSON，不要 Markdown，不要解释）
{"reply":"对用户说的一句中文","ops":[{"op":"...","...":"..."}]}

## 操作（按顺序执行）
- {"op":"add","class_type":"EmptyImage","id":"可选","title":"可选显示名","inputs":{"width":512}}  加节点；inputs 只填标量参数，系统自动补默认值；连线用 connect
- {"op":"remove","id":"2"}  删除节点，并自动清理指向它的连线
- {"op":"connect","id":"3","key":"images","from":["1",0]}  建立连线，类型必须匹配
- {"op":"disconnect","id":"3","key":"images"}  断开连线
- {"op":"set","id":"1","key":"width","value":512}  修改标量参数
- {"op":"setMeta","id":"1","title":"新名字"}  改显示名

## 规则
- 只做用户要求的改动，小步操作；不要重排或"顺手优化"别人的图。
- add 的 class_type 只能来自目录里的类型；不确定的参数就少填，系统会补默认值，缺必填会在校验时报出来。
- STRING 类型的连线只用于 first_frame_url 这类传递场景，普通提示词直接 set。
- 你不负责执行；用户会审查你的改动后自己决定是否重跑。
${lessonText}`;

  const user = `当前图：\n${JSON.stringify(currentGraph)}\n\n节点目录（add 可用的 class_type）：\n${catalog}\n\n用户要求：${userText}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
