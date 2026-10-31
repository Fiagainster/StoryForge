import type {
  Asset,
  ChatMessage,
  ComfyGraph,
  DramaPlan,
  RunRecord,
  RunUsage,
  ShotCost,
} from "../types";
import { llmChatStream } from "./api";
import type { ComfyClient, WatchEvent } from "./comfy";
import { BLOCKED_INDEX, NODES, NODE_INDEX, LIB_STATS, MISSING_CORE } from "./nodeSearch";
import { applyBudget, buildRepairMessages, compilePlan, parsePlan, parseRepair, planStats } from "./plan";
import type { Budget } from "./plan";
import { applyGraphOps, buildGraphEditMessages } from "./graphOps";
import { auditGraph, hasGenerator } from "./graphAudit";
import type { AuditIssue } from "./graphAudit";

export { applyBudget };
export type { Budget };

/* ------------------------------------------------------------------ *
 * 系统提示词：只写计划，不写节点图
 * 图由编译器根据计划生成，保证连线、类型、终点永远合法
 * ------------------------------------------------------------------ */

export function buildPlanPrompt(opts: {
  hasArkKey: boolean;
  lastPlan?: DramaPlan | null;
  lessons?: string[];
  hasLastGraph?: boolean;
}): string {
  const videoRule = opts.hasArkKey
    ? `- 用户说「拍/镜头/视频/成片」时 mode 用 video，会出图并逐镜生成视频；只说「一张图/分镜/画面」时用 image。`
    : `- 当前没有配置 ARK Key，mode 只能是 image；reply 里提醒用户配置 Key 后才会真实生成。`;

  const last = opts.lastPlan
    ? `\n## 上一版计划\n用户说「改一下」「再来一版」时基于它改；没有要求改的角色锚点必须逐字保留。\n${JSON.stringify(
        opts.lastPlan
      )}\n`
    : "";

  const lessons = opts.lessons?.length
    ? `\n## 已沉淀的经验（来自过去失败的修复，务必规避）\n${opts.lessons
        .map((l) => `- ${l}`)
        .join("\n")}\n`
    : "";

  // 画布共编：当前有图时，智能体拥有和人类一样的图编辑权（ops 协议）
  const coEdit =
    opts.hasLastGraph
      ? `\n## 画布共编：直接改现有图
当前画布上有一张节点图（JSON 见用户消息）。当用户想改这张图——加/删节点、改连线、改图里的参数——不要输出 plan，输出画布操作：
{"reply":"一句话中文","ops":[{"op":"add","class_type":"...","inputs":{...}},{"op":"connect","id":"3","key":"images","from":["1",0]},{"op":"set","id":"1","key":"width","value":512},{"op":"remove","id":"2"}]}
操作协议：add（class_type 必须来自下方目录，inputs 只填标量）/ remove / connect（from: [来源ID, 输出序号]，类型必须匹配）/ disconnect / set（标量）/ setMeta。
规则：小步操作，只做用户要求的改动；改完就结束，不要问"要不要执行"，执行由用户在画布上点「开始生成」；输出 ops 时不要再输出 plan，要拍新内容时才输出 plan。
硬性要求：你的改动必须让这张图仍然可执行——新增节点要立刻把必填输入接上（add 之后用 connect 补），删节点前先想好下游那根线怎么办；一次能改完的就一次改完，不要只动一个参数就算交付。改完我会自检，跑不起来会退回来让你重修，修不好就整版撤回。
画布是你的工作台，不是用户的工作台：用户说"把时长改成 8 秒""换成特写""光照太暗了""加一个放大节点"，一律自己用 ops/set 改到图上，改完只回一句你改了什么。绝不要求用户自己去画布里调参数，也不要在对话里罗列参数让用户选。

### 节点目录（add 可用的 class_type）
${NODES.map((n) => `${n.n} — ${n.d} · ${n.c}`).join("\n")}\n`
      : "";

  return `你是 StoryForge 的短剧工作台助手，既能策划拍摄，也能正常聊天。

## 三种回应（输出严格 JSON，互斥，按用户意图选一种）
1. **用户想拍东西 / 改上一版计划** → {"reply":"对用户说的一句中文","plan":{...}}（计划结构见下）
2. **用户要改当前画布上的图**（仅当存在当前图）→ {"reply":"...","ops":[...]}（操作协议见下）
3. **用户在打招呼、问你是谁、问怎么用、闲聊、问能力边界、表达感受** → {"reply":"自然语言的中文回答","chat":true}
   - 绝对不要为聊天编造计划或工作流；回答像正常人说话，可以介绍你能做什么、该怎么用。
   - 判断标准：用户没有明确要拍具体内容，就是聊天。哪怕只说了「你好」「在吗」，也必须输出 chat:true，绝不要输出 plan 字段。
   - 例子：「你好」→ {"reply":"你好！说一句想拍的东西，我把分镜图搭到右边画布上，你在画布改到满意再点开始生成。","chat":true}
4. 确实做不到时 → {"reply":"说明缺什么","plan":null}

## 计划格式（仅第 1 种时输出）
{
  "reply": "对用户说的一句中文",
  "plan": {
    "title": "片名",
    "mode": "video",
    "style": "全片风格前缀：影调、光线、质感、画幅，逐字复用",
    "characters": [
      {"id": "c1", "name": "角色名", "anchor": "年龄、外貌、发型、服装、气质的逐字锚点，30-80 字"}
    ],
    "shots": [
      {
        "title": "镜头名",
        "characters": ["c1"],
        "location": "场景",
        "action": "这一镜画面里谁在做什么、环境是什么",
        "emotion": "情绪",
        "dialogue": "可选，角色台词",
        "shotSize": "中景",
        "camera": "缓慢推近",
        "duration": 6,
        "generateAudio": true
      }
    ]
  }
}

## 计划硬性规则
- 默认 1-3 个镜头；只有用户明确要求多镜，才加到最多 6 个。不擅自加戏。
- shotSize 只能是：大远景、远景、全景、中景、中近景、近景、特写、大特写。
- camera 只能是：固定、缓慢推近、缓慢拉远、横移、跟拍、手持、环绕、俯拍、仰拍。
- duration 默认 4-6 秒，一般不超过 8 秒；只有用户明确要长镜头，才用 9-15 秒。
- 每个镜头的 characters 必须来自 characters 数组，同框最多 3 人。
- 角色锚点逐字复用：同一角色跨镜头必须完全一致；不要在镜头里重新描述外貌。
- style 是全片统一前缀：写清影调、光线、质感、画幅（竖屏 9:16）、画面无文字无水印。
- action 写具体动作与场景，不要写抽象形容词；这是首帧生成的核心提示。只写镜头里看得见的动作、环境、天气，不写心理活动和画外音。
- dialogue 只写角色当场说出口的台词，每行「角色名：台词」；旁白、心声、动作提示都不要写进来；没有台词就留空字符串。
- 有 dialogue 的镜头 generateAudio 必须 true；纯环境音镜头才用 false。
- 同一场景连续镜头的 location 逐字一致，方便画面衔接。
- 不要输出 ComfyUI 节点、class_type、连线；只输出计划。
- 计划会被编译成一张图放到画布上。所以 reply 里不要让人"确认参数"，只说明你把什么放到画布上了。
- 用户想在现有分镜**后面加镜头**（"加一个镜头""再来一场""补一镜"，且画布上已有分镜）时：在 plan 同级加 "append": true，plan 的 shots 只写**新增**的镜头，已有镜头绝对不要重复写；已有角色逐字复用锚点，新角色才写进 characters。改已有镜头的参数用 ops，不要用 append。
${videoRule}
${last}${lessons}${coEdit}`;
}

export function parseJsonLoose(raw: string): any | null {
  let s = (raw || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 执行复用：提交图 → 等待 → RunRecord
 * ------------------------------------------------------------------ */

/** 一轮回复里的一个可见步骤（思考 / 工具调用 / 模型原始输出） */
export interface StepEvent {
  id: string;
  kind: "think" | "tool" | "output";
  title: string;
  status: "running" | "done" | "error";
  detail?: string;
  note?: string;
}

let stepSeq = 0;
const newStepId = () => `st${Date.now().toString(36)}${(stepSeq++).toString(36)}`;

/**
 * 从正在流式到达的 JSON 里抽出 reply 字段的当前值。
 * 模型按 {"reply": "...", "plan": ...} 的顺序输出，所以正文可以边生成边显示，
 * 而不用等整段 JSON 落地（否则用户要盯着空白等十几秒）。
 */
export function extractPartialReply(buf: string): string {
  const m = /"reply"\s*:\s*"/.exec(buf);
  if (!m) return "";
  let i = m.index + m[0].length;
  let out = "";
  while (i < buf.length) {
    const ch = buf[i];
    if (ch === "\\") {
      const n = buf[i + 1];
      if (n === undefined) break;
      if (n === "u") {
        const hex = buf.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "" : n;
      i += 2;
      continue;
    }
    if (ch === '"') break;
    out += ch;
    i += 1;
  }
  return out;
}

/** 把上游错误翻译成能照着修的一句话 */
export function humanError(raw: string): string {
  const s = raw.replace(/^Error:\s*/i, "");
  if (s.includes("NO_KEY")) return "还没有填对话模型的 API Key（设置 → 对话模型）";
  if (s.includes("NO_MODEL")) return "还没有填对话模型 ID（设置 → 对话模型）";
  const http = /HTTP\s+(\d{3})/.exec(s);
  if (http) {
    const code = http[1];
    const tail = s.split("\n").slice(0, 3).join(" ").slice(0, 300);
    if (code === "401" || code === "403") return `鉴权失败（${code}），Key 不对或无权访问该模型｜${tail}`;
    if (code === "402") return `账户余额不足（402），充值后再试｜${tail}`;
    if (code === "404") return `模型或地址不存在（404），多半是模型 ID 写错｜${tail}`;
    if (code === "429") return `请求太频繁或额度用尽（429），稍后再试｜${tail}`;
    if (code === "400") return `请求被拒绝（400），模型名或参数不被支持｜${tail}`;
    return `HTTP ${code}｜${tail}`;
  }
  if (s.includes("timed out") || s.includes("timeout")) return "请求超时，检查网络或代理";
  if (s.includes("error sending request")) return "连不上模型服务，检查网络或 Base URL";
  return s.slice(0, 300);
}

interface RunCallbacks {
  onLog?: (level: "info" | "warn" | "error", text: string) => void;
  onStage?: (stage: string) => void;
  /** 模型流式增量：content 是正文（JSON / 文本），reasoning 是思考 */
  onDelta?: (kind: "content" | "reasoning", text: string) => void;
  /** 过程步骤：思考、模型输出、编译、校验、执行 */
  onStep?: (step: StepEvent) => void;
  /** ComfyUI 实时进度：哪个节点在跑、跑到几成 */
  onNode?: (e: WatchEvent) => void;
}

const isVideoAsset = (a: { kind?: string; url: string }) =>
  a.kind === "video" || /\.(mp4|webm|mov|mkv)(?:[?&#]|$)/i.test(a.url);

function usageFromAssets(assets: { kind?: string; url: string; duration?: number }[], llmTokens: number): RunUsage {
  let images = 0;
  let videoSeconds = 0;
  for (const a of assets) {
    if (isVideoAsset(a)) videoSeconds += a.duration || 0;
    else if (a.kind !== "audio") images += 1;
  }
  return {
    llmTokens,
    images,
    videoSeconds: Math.round(videoSeconds * 10) / 10,
  };
}

async function submitAndWait(
  graph: ComfyGraph,
  client: ComfyClient,
  cb: RunCallbacks,
  note?: string,
  llmTokens = 0
): Promise<RunRecord> {
  const log = cb.onLog || (() => {});
  const clientId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  const startedAt = Date.now();
  /**
   * 逐镜成本拆解：把 /ws 按 shot_N_ 前缀切段，每段记三件事——
   *   wait   上一镜结束到这一镜开跑之间干等的时间（本机排队；云端排队还在节点里，看不到）
   *   busy   这一镜自己的节点在跑的墙钟
   *   retries 同一镜的节点被重复执行的次数（重跑 / 重试），0 就是一次过
   * 只记真能观测到的量，不往里塞推测值。
   */
  const shotCost: Record<string, ShotCost> = {};
  const seenNodes: Record<string, Set<string>> = {};
  let curShot: number | null = null;
  let curAt = 0;
  let lastEndAt = startedAt;
  const bucket = (n: number): ShotCost => {
    const k = String(n);
    return (shotCost[k] ??= { wait: 0, busy: 0, retries: 0 });
  };
  const openShot = (n: number) => {
    const c = bucket(n);
    c.wait += Math.max(0, Date.now() - lastEndAt);
    curShot = n;
    curAt = Date.now();
  };
  const closeShot = () => {
    if (curShot !== null && curAt) {
      const c = bucket(curShot);
      c.busy += Math.max(0, Date.now() - curAt);
      lastEndAt = Date.now();
    }
    curShot = null;
    curAt = 0;
  };
  const shotOf = (id?: string) => {
    const m = /^shot_(\d+)_/.exec(id || "");
    return m ? Number(m[1]) : null;
  };
  // 先挂上 /ws 再提交：晚一步就会漏掉最开始的 executing
  const stopWatch = client.watch(clientId, (e) => {
    if (e.kind === "start") {
      closeShot();
      lastEndAt = Date.now();
    } else if (e.kind === "node" || e.kind === "progress") {
      const n = shotOf(e.node);
      if (n !== null) {
        if (n !== curShot) {
          closeShot();
          openShot(n);
        }
        // 同一个节点又开了一次 = 重跑/重试
        if (e.kind === "node" && e.node) {
          const seen = (seenNodes[String(n)] ??= new Set());
          if (seen.has(e.node)) bucket(n).retries += 1;
          else seen.add(e.node);
        }
      }
    } else if (e.kind === "done" || e.kind === "error") {
      closeShot();
    }
    cb.onNode?.(e);
  });
  const promptId = await client.queuePrompt(graph, clientId);
  log("info", `已提交执行，prompt_id=${promptId}`);
  let assets: Asset[] = [];
  let cost: { estimated: number; buffered: number; actual: number } | undefined;
  try {
    ({ assets, cost } = await client.waitForPrompt(promptId, (elapsed) => {
      if (elapsed > 0 && Math.floor(elapsed / 5000) !== Math.floor((elapsed - 700) / 5000)) {
        log("info", `生成中… ${Math.round(elapsed / 1000)}s`);
      }
    }));
  } finally {
    stopWatch();
    closeShot();
  }
  const usage = usageFromAssets(assets, llmTokens);
  if (cost) usage.costCny = Math.round(cost.actual * 100) / 100;
  log(
    "info",
    `完成，产出 ${assets.length} 个文件（${usage.images} 图 · ${usage.videoSeconds}s 视频 · LLM ${usage.llmTokens} tokens）${
      cost
        ? ` · 实际 ¥${usage.costCny?.toFixed(2)}（预估 ¥${cost.estimated.toFixed(2)}，含重试缓冲至多 ¥${cost.buffered.toFixed(2)}）`
        : ""
    }`
  );
  return {
    id: promptId.slice(0, 8),
    promptId,
    graph,
    status: "done",
    assets,
    usage,
    startedAt,
    finishedAt: Date.now(),
    note,
    shotCost: Object.keys(shotCost).length ? shotCost : undefined,
  };
}

interface CompileRunOptions {
  hasArkKey: boolean;
  imageModel?: string;
  imageSize?: string;
  videoModel?: string;
  videoResolution?: string;
  generateAudio?: boolean;
  /** 出计划那轮消耗的 LLM tokens，记进本次运行的用量 */
  llmTokens?: number;
}

/** 编译计划 → 校验 → 提交执行。确认门通过后（或免确认路径）都走这里。 */
async function compileAndRun(
  plan: DramaPlan,
  opts: CompileRunOptions,
  client: ComfyClient | null,
  cb: RunCallbacks,
  ctx: { reply: string; degraded: boolean; note?: string }
): Promise<AgentResult> {
  const log = cb.onLog || (() => {});
  const stage = cb.onStage || (() => {});
  const step = cb.onStep || (() => {});
  const withVideo = opts.hasArkKey && plan.mode === "video";

  stage("编译分镜图");
  const compileAt = Date.now();
  const compileId = newStepId();
  step({ id: compileId, kind: "tool", title: "编译节点图", status: "running" });
  const graph = compilePlan(plan, {
    imageModel: opts.imageModel || "doubao-seedream-5-0-pro-260628",
    imageSize: opts.imageSize || "1080x1920",
    videoModel: opts.videoModel || "doubao-seedance-2-5-260628",
    videoResolution: opts.videoResolution || "720p",
    generateAudio: opts.generateAudio !== false,
    withVideo,
    continuity: true,
  });
  step({
    id: compileId,
    kind: "tool",
    title: "编译节点图",
    status: "done",
    note: `${Object.keys(graph).length} 个节点 · ${((Date.now() - compileAt) / 1000).toFixed(1)}s`,
  });

  const checkId = newStepId();
  step({ id: checkId, kind: "tool", title: "校验连线与类型", status: "running" });
  const { graph: checked, errors, repairs } = validateAndRepair(graph);
  if (repairs.length) log("info", `自动修正：${repairs.join("；")}`);
  step({
    id: checkId,
    kind: "tool",
    title: "校验连线与类型",
    status: errors.length ? "error" : "done",
    note: errors.length
      ? `${errors.length} 个问题`
      : repairs.length
      ? `通过 · 自动修正 ${repairs.length} 处`
      : "通过",
    detail: errors.length ? errors.join("\n") : repairs.length ? repairs.join("\n") : undefined,
  });
  if (errors.length) {
    log("error", `校验未通过：${errors.join("；")}`);
    return {
      reply: `${ctx.reply}\n\n分镜图没通过校验：${errors[0]}`,
      plan,
      graph: checked,
      degraded: ctx.degraded,
      error: errors.join("；"),
    };
  }

  if (!opts.hasArkKey) {
    return {
      reply: `${ctx.reply}\n\n还没有配置 ARK Key，计划已生成但不会调用生成模型。`,
      plan,
      graph: checked,
      degraded: ctx.degraded,
    };
  }
  if (!client) {
    return {
      reply: `${ctx.reply}\n\n（内核未就绪，计划已生成但未执行）`,
      plan,
      graph: checked,
      degraded: ctx.degraded,
    };
  }

  stage("生成中");
  const runAt = Date.now();
  const runStepId = newStepId();
  step({
    id: runStepId,
    kind: "tool",
    title: withVideo ? "执行内核 · 逐镜出图与视频" : "执行内核 · 逐镜出图",
    status: "running",
  });
  try {
    const run = await submitAndWait(checked, client, cb, ctx.note, opts.llmTokens ?? 0);
    step({
      id: runStepId,
      kind: "tool",
      title: withVideo ? "执行内核 · 逐镜出图与视频" : "执行内核 · 逐镜出图",
      status: "done",
      note: `${run.assets.length} 个文件 · ${((Date.now() - runAt) / 1000).toFixed(0)}s`,
      detail: `prompt_id ${run.promptId}`,
    });
    return {
      reply: `${ctx.reply} · 完成`,
      plan,
      graph: checked,
      run,
      degraded: ctx.degraded,
    };
  } catch (e) {
    const msg = String(e);
    log("error", msg);
    step({
      id: runStepId,
      kind: "tool",
      title: withVideo ? "执行内核 · 逐镜出图与视频" : "执行内核 · 逐镜出图",
      status: "error",
      note: ((Date.now() - runAt) / 1000).toFixed(0) + "s",
      detail: msg,
    });
    return {
      reply: `${ctx.reply} · 执行失败：${msg}`,
      plan,
      graph: checked,
      degraded: ctx.degraded,
      error: msg,
    };
  }
}

export interface ExecuteOptions extends CompileRunOptions {
  budget?: Budget | null;
  /** 展示用前缀，如「重跑镜头 2」 */
  label?: string;
  note?: string;
  /** 出计划用的对话模型可用（决定失败后能否自动修复） */
  hasModelKey?: boolean;
  /** 执行失败时自动把错误喂回模型修订计划（最多 1 次） */
  repairOnFailure?: boolean;
  /** 已沉淀的经验，修复时一并注入 */
  lessons?: string[];
  /** 修复成功后提炼的经验，通过这里交回调用方沉淀 */
  onLesson?: (lesson: string) => void;
}

/**
 * 确认门 / 单镜重跑的入口：把一份计划真正落地执行。
 * 会先做预算截断，再编译、校验、执行。
 */
export async function executePlan(
  plan: DramaPlan,
  client: ComfyClient | null,
  cb: RunCallbacks = {},
  opts: ExecuteOptions = { hasArkKey: true }
): Promise<AgentResult> {
  const log = cb.onLog || (() => {});
  const { plan: finalPlan, warnings } = applyBudget(plan, opts.budget);
  for (const w of warnings) log("warn", w);

  const stats = planStats(finalPlan);
  const prefix = opts.label ? `${opts.label} · ` : "已开拍 · ";
  const reply = `${prefix}${finalPlan.title}｜${stats.shots} 镜｜约 ${stats.seconds}s`;

  return compileAndRun(
    finalPlan,
    {
      hasArkKey: !!opts.hasArkKey,
      imageModel: opts.imageModel,
      imageSize: opts.imageSize,
      videoModel: opts.videoModel,
      videoResolution: opts.videoResolution,
      generateAudio: opts.generateAudio,
      llmTokens: opts.llmTokens,
    },
    client,
    cb,
    { reply, degraded: false, note: opts.note }
  );
}

/**
 * 自我进化闭环：执行失败时把错误喂回模型修订计划（最多 1 次），
 * 并从这次失败里提炼一句经验沉淀下来，之后出计划都会带着它。
 */
export async function executePlanWithRepair(
  plan: DramaPlan,
  client: ComfyClient | null,
  cb: RunCallbacks = {},
  opts: ExecuteOptions = { hasArkKey: true }
): Promise<AgentResult & { lesson?: string }> {
  const log = cb.onLog || (() => {});
  const first = await executePlan(plan, client, cb, opts);

  const repairable = !!first.error && !!opts.repairOnFailure && !!opts.hasModelKey;
  if (!repairable) return first;

  stage(cb, "自动修复计划");
  log("warn", "执行失败，把错误喂回模型尝试修复…");
  let repaired: { plan: DramaPlan; lesson: string } | null = null;
  let usage: RunUsage | null = null;
  try {
    const messages = buildRepairMessages(plan, first.error!, opts.lessons ?? []);
    const resp = await llmJsonChat(messages, cb, "自动修复计划");
    const tokens = resp.tokens;
    if (tokens > 0) log("info", `修复对话用量：${tokens} tokens`);
    usage = { llmTokens: tokens, images: 0, videoSeconds: 0 };
    const parsed = parseJsonLoose(resp.content ?? "");
    if (parsed) repaired = parseRepair(parsed);
  } catch (e) {
    log("warn", `自动修复失败：${e}`);
  }
  if (!repaired) {
    log("error", "模型没有给出可用的修订计划，保留首次错误");
    return first;
  }
  if (repaired.lesson) {
    log("info", `沉淀经验：${repaired.lesson}`);
    opts.onLesson?.(repaired.lesson);
  }

  const second = await executePlan(repaired.plan, client, cb, {
    ...opts,
    label: "修复重试",
    note: "失败自动修复后重试",
    llmTokens: usage?.llmTokens ?? 0,
  });
  return {
    ...second,
    lesson: repaired.lesson,
    reply: second.error
      ? `${second.reply}\n（自动修复重试仍失败，可手动改参后重跑）`
      : `${second.reply}\n（首次执行失败，已自动修复重试）`,
  };
}

function stage(cb: RunCallbacks, s: string) {
  cb.onStage?.(s);
}

/**
 * 人在图上改：把（可能被手动编辑过的）节点图直接校验并执行。
 * 不走计划编译——人改的就是最终图。
 */
export async function executeEditedGraph(
  graph: ComfyGraph,
  client: ComfyClient | null,
  cb: RunCallbacks = {},
  note?: string
): Promise<AgentResult> {
  const log = cb.onLog || (() => {});
  const stage = cb.onStage || (() => {});
  stage("校验修改后的图");
  const { graph: checked, errors, repairs } = validateAndRepair(graph);
  if (repairs.length) log("info", `自动修正：${repairs.join("；")}`);
  if (errors.length) {
    log("error", `校验未通过：${errors.join("；")}`);
    return {
      reply: `修改后的图没通过校验：${errors[0]}`,
      graph: checked,
      error: errors.join("；"),
    };
  }
  if (!client) {
    return {
      reply: "（内核未就绪，修改已保存但未执行）",
      graph: checked,
    };
  }
  stage("生成中");
  try {
    const run = await submitAndWait(checked, client, cb, note ?? "按画布执行", 0);
    return {
      reply: `画布已执行（${Object.keys(checked).length} 个节点），产物在「分镜」里`,
      graph: checked,
      run,
    };
  } catch (e) {
    const msg = String(e);
    log("error", msg);
    return { reply: `执行失败：${msg}`, graph: checked, error: msg };
  }
}

/* ------------------------------------------------------------------ *
 * 校验与自修复（计划图仍要过这一道）
 * ------------------------------------------------------------------ */

const SINK_TYPES = new Set([
  "SaveImage",
  "PreviewImage",
  "SaveVideo",
  "SaveAudio",
  "SaveAudioMP3",
  "SaveWEBM",
  "PreviewAudio",
]);

export interface ValidationResult {
  graph: ComfyGraph;
  errors: string[];
  repairs: string[];
}

export function validateAndRepair(input: unknown): ValidationResult {
  const errors: string[] = [];
  const repairs: string[] = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { graph: {}, errors: ["图不是一个对象"], repairs };
  }

  const graph: ComfyGraph = JSON.parse(JSON.stringify(input));

  for (const [id, node] of Object.entries<any>(graph)) {
    if (!node || typeof node !== "object") {
      errors.push(`节点 ${id} 不是对象`);
      continue;
    }
    const card = NODE_INDEX.get(node.class_type);
    if (!card) {
      const blocked = BLOCKED_INDEX.get(node.class_type);
      if (blocked) {
        errors.push(
          `节点 ${id} 用了 "${node.class_type}"，它需要本地模型权重（${blocked.why.join("/")}），当前环境没有`
        );
      } else {
        errors.push(`节点 ${id} 使用了未知类型 "${node.class_type}"`);
      }
      continue;
    }
    if (!node.inputs || typeof node.inputs !== "object") {
      node.inputs = {};
      repairs.push(`节点 ${id} 补上空的 inputs`);
    }

    for (const spec of card.in) {
      if (spec.grow) {
        const pref = spec.grow;
        const filled = Object.keys(node.inputs).filter(
          (k) => k.startsWith(pref) && /^\d+$/.test(k.slice(pref.length))
        );
        if (filled.length < (spec.gmin ?? 1)) {
          errors.push(
            `节点 ${id}(${node.class_type}) 的可变输入需要至少 ${spec.gmin ?? 1} 路，键名写成 "${pref}0"、"${pref}1"…`
          );
        }
        continue;
      }
      if (spec.k in node.inputs) continue;
      if (spec.def !== undefined) {
        node.inputs[spec.k] = spec.def;
        repairs.push(`节点 ${id}.${spec.k} 补默认值 ${JSON.stringify(spec.def)}`);
      } else if (spec.req) {
        errors.push(`节点 ${id}(${node.class_type}) 缺少必填输入 "${spec.k}"（${spec.t}）`);
      }
    }

    for (const spec of card.in) {
      const v = node.inputs[spec.k];
      if (!spec.opts || spec.trunc) continue;
      if (typeof v !== "string") continue;
      if (!spec.opts.includes(v)) {
        const fallback = (spec.def as string) ?? spec.opts[0];
        errors.push(`节点 ${id}.${spec.k} 的值 "${v}" 不在允许范围`);
        node.inputs[spec.k] = fallback;
        repairs.push(`节点 ${id}.${spec.k} 回退到 ${fallback}`);
      }
    }
  }

  for (const [id, node] of Object.entries<any>(graph)) {
    for (const [name, value] of Object.entries<any>(node.inputs || {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string") {
        if (!graph[value[0]]) {
          errors.push(`节点 ${id}.${name} 引用了不存在的节点 ${value[0]}`);
        }
      }
    }
  }

  const sinks = Object.entries<any>(graph).filter(([, n]) => SINK_TYPES.has(n.class_type));
  if (!sinks.length) {
    errors.push("缺少保存节点（SaveImage / SaveVideo / SaveAudio）作为终点");
  }
  for (const [id, node] of sinks) {
    const mainInput = node.inputs?.images ?? node.inputs?.video ?? node.inputs?.audio;
    if (!Array.isArray(mainInput)) {
      errors.push(`终点节点 ${id}(${node.class_type}) 的输入必须是连线，不能是常量`);
    }
  }

  const state = new Map<string, number>();
  const dfs = (id: string): boolean => {
    const st = state.get(id) || 0;
    if (st === 1) return true;
    if (st === 2) return false;
    state.set(id, 1);
    const node: any = graph[id];
    for (const v of Object.values<any>(node?.inputs || {})) {
      if (Array.isArray(v) && typeof v[0] === "string" && graph[v[0]]) {
        if (dfs(v[0])) return true;
      }
    }
    state.set(id, 2);
    return false;
  };
  for (const id of Object.keys(graph)) {
    if (dfs(id)) {
      errors.push("图中存在环，无法执行");
      break;
    }
  }

  return { graph, errors, repairs };
}

/* ------------------------------------------------------------------ *
 * 演示图：没有模型 Key 时的本地兜底
 * ------------------------------------------------------------------ */

const DEMO_COLORS = [0x1b2430, 0x2a1f2e, 0x1f2a24, 0x2b2418, 0x232338];

export function demoGraph(seed = Date.now()): ComfyGraph {
  const color = DEMO_COLORS[seed % DEMO_COLORS.length];
  return {
    "1": {
      class_type: "EmptyImage",
      inputs: { width: 1080, height: 1920, batch_size: 1, color },
      _meta: { title: "占位画面" },
    },
    "2": {
      class_type: "ImageScale",
      inputs: {
        image: ["1", 0],
        upscale_method: "lanczos",
        width: 1080,
        height: 1920,
        crop: "disabled",
      },
      _meta: { title: "规整画幅" },
    },
    "3": {
      class_type: "SaveImage",
      inputs: { images: ["2", 0], filename_prefix: "storyforge/demo" },
      _meta: { title: "保存" },
    },
  };
}

/* ------------------------------------------------------------------ *
 * 一轮对话
 * ------------------------------------------------------------------ */

export interface AgentCallbacks {
  onLog?: (level: "info" | "warn" | "error", text: string) => void;
  onStage?: (stage: string) => void;
  onDelta?: (kind: "content" | "reasoning", text: string) => void;
  onStep?: (step: StepEvent) => void;
  /** ComfyUI 实时进度：哪个节点在跑、跑到几成 */
  onNode?: (e: WatchEvent) => void;
}

export interface AgentOptions {
  /** 是否已配置对话模型 Key */
  hasModelKey?: boolean;
  /** 是否已配置 ARK Key（生图/生视频） */
  hasArkKey?: boolean;
  imageModel?: string;
  imageSize?: string;
  videoModel?: string;
  videoResolution?: string;
  generateAudio?: boolean;
  /** 上一轮的计划，用于"改一下" */
  lastPlan?: DramaPlan | null;
  /** 上一轮的图，兼容旧的图生成路径 */
  lastGraph?: ComfyGraph | null;
  /** 有 ARK Key 时先出计划等确认，不直接执行 */
  confirmBeforeRun?: boolean;
  /** 单次生成的预算上限 */
  budget?: Budget | null;
  /** 已沉淀的经验教训，注入计划提示词 */
  lessons?: string[];
}

export interface AgentResult {
  reply: string;
  graph?: ComfyGraph;
  plan?: DramaPlan;
  run?: RunRecord;
  degraded?: boolean;
  error?: string;
  /** 计划已就绪，等待用户确认后再执行 */
  needsConfirm?: boolean;
  /** 智能体通过 ops 协议改了现有图，改动进画布等人审查 */
  graphEdited?: boolean;
  /** 计划是"往后追加新镜"而不是整版重铺：store 编译时从现有最大镜号+1 接着编 */
  append?: boolean;
  /** 本轮对话模型用量（token） */
  usage?: RunUsage | null;
  /** 本轮实际发给模型的系统提示词，用于人工审查 */
  prompt?: string;
}

/** 流式调用模型，并把这次调用落成一条可见步骤 */
async function llmJsonChat(
  messages: { role: string; content: string }[],
  cb: RunCallbacks = {},
  label = "对话模型"
): Promise<{ content: string; reasoning: string; tokens: number; ms: number }> {
  const log = cb.onLog || (() => {});
  const id = newStepId();
  const t0 = Date.now();
  cb.onStep?.({ id, kind: "output", title: label, status: "running" });

  const ask = (jsonMode: boolean, extra?: string) =>
    llmChatStream({
      streamId: id,
      messages: extra ? [...messages, { role: "user", content: extra }] : messages,
      jsonMode,
      onDelta: cb.onDelta,
    });

  let resp;
  try {
    resp = await ask(true);
  } catch (e) {
    const msg = String(e);
    // 有的模型/网关不接受 response_format：降级成普通模式再来一次
    if (/response_format|json_object|HTTP 400/i.test(msg)) {
      log("warn", "上游拒绝 JSON 模式，改用普通模式重试");
      resp = await ask(false);
    } else {
      cb.onStep?.({ id, kind: "output", title: label, status: "error", detail: msg });
      throw e;
    }
  }

  if (resp.cancelled) {
    cb.onStep?.({ id, kind: "output", title: label, status: "error", note: "已停止" });
    throw new Error(CANCELLED);
  }

  // 推理模型偶发「只想不说话」：思考写完就停，正文一个字没有。
  // 这时不能算失败，换一条采样路径（去掉 JSON 约束）再要一次。
  if (!resp.content.trim() && (resp.reasoning || "").trim()) {
    log(
      "warn",
      `模型只输出了思考（${resp.reasoning.length} 字）没有正文${
        resp.finishReason ? `，finish=${resp.finishReason}` : ""
      }，再要一次`
    );
    resp = await ask(
      false,
      "上一轮你只写了思考、正文是空的。现在直接输出 JSON 正文（形如 {\"reply\":\"…\"}），不要任何思考过程。"
    );
  }

  if (resp.cancelled) {
    cb.onStep?.({ id, kind: "output", title: label, status: "error", note: "已停止" });
    throw new Error(CANCELLED);
  }

  const tokens = Number(resp.usage?.total_tokens) || 0;
  const ms = Date.now() - t0;
  if (tokens > 0) log("info", `对话模型用量：${tokens} tokens（${(ms / 1000).toFixed(1)}s）`);
  cb.onStep?.({
    id,
    kind: "output",
    title: label,
    status: "done",
    note: `${tokens ? `${tokens} tokens · ` : ""}${(ms / 1000).toFixed(1)}s${
      resp.finishReason && resp.finishReason !== "stop" ? ` · ${resp.finishReason}` : ""
    }`,
    detail: resp.content.slice(0, 12000) || `（正文为空）\n思考：${(resp.reasoning || "").slice(0, 800)}`,
  });
  return { content: resp.content, reasoning: resp.reasoning, tokens, ms };
}

/** 用户点了停止：用这个哨兵把整轮打断，由 store 翻译成"已经停了" */
export const CANCELLED = "__cancelled_by_user__";

/** 这段文字像不像"人说的话"：碎 JSON、代码、纯符号都不算 */
function looksLikeProse(t: string): boolean {
  const text = (t || "").trim();
  if (!text) return false;
  if (/^[\[{<(`\d"'\-*+·]/.test(text)) return false;
  if (/^[\w.]+\s*=\s*/.test(text)) return false;
  if (/[{}]/.test(text)) return false;
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  return cjk >= 4 && text.length >= 6;
}

export async function runAgentTurn(
  userText: string,
  client: ComfyClient | null,
  history: ChatMessage[],
  cb: AgentCallbacks = {},
  opts: AgentOptions = {}
): Promise<AgentResult> {
  const log = cb.onLog || (() => {});
  const stage = cb.onStage || (() => {});
  const hasModelKey = !!opts.hasModelKey;
  const hasArkKey = !!opts.hasArkKey;

  stage("理解意图");
  const systemPrompt = buildPlanPrompt({
    hasArkKey,
    lastPlan: opts.lastPlan,
    lessons: opts.lessons,
    hasLastGraph: !!opts.lastGraph,
  });
  const messages: { role: string; content: string }[] = [
    { role: "system", content: systemPrompt },
  ];

  if (opts.lastGraph) {
    messages.push({
      role: "system",
      content: `上一轮的节点图（仅在需要兼容旧模式时参考）：\n${JSON.stringify(opts.lastGraph)}`,
    });
  }

  for (const m of history.filter((m) => m.role !== "system").slice(-8)) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: "user", content: userText });

  const done = (r: Omit<AgentResult, "prompt">): AgentResult => ({ ...r, prompt: systemPrompt });

  let parsed: any = null;
  let degraded = false;
  let llmTokens = 0;
  let rawText = "";
  let reasoningText = "";

  try {
    const resp = await llmJsonChat(messages, cb, "写拍摄方案");
    rawText = (resp.content ?? "").trim();
    reasoningText = (resp.reasoning ?? "").trim();
    llmTokens = resp.tokens;
    parsed = parseJsonLoose(rawText);
    if (!parsed) {
      // 模型可能直接说了人话（没包 JSON）：像人话才当聊天展示
      if (looksLikeProse(rawText)) {
        log("info", "模型返回了纯文本回答，按对话处理");
        return done({ reply: rawText, degraded: false });
      }
      // 不像人话也不像 JSON：多半是被截断了。再要一次，别拿碎片糊弄人
      log("warn", `模型返回的既不是 JSON 也不是一句话（${rawText.length} 字），再要一次`);
      if (hasModelKey) {
        try {
          const retry = await llmJsonChat(
            [
              ...messages,
              { role: "assistant", content: rawText || "（空）" },
              {
                role: "user",
                content:
                  `上一轮你的输出既不是合法 JSON，也不是一句完整的话（可能被截断了）。现在只输出一个 JSON 对象：要动手就 {"reply":"…","ops":[…]} 或带 "plan"，只是聊天就 {"reply":"…","chat":true}。不要思考过程，不要 markdown。`,
              },
            ],
            cb,
            "重来一次"
          );
          const retried = parseJsonLoose(retry.content);
          llmTokens += retry.tokens;
          if (retried) {
            parsed = retried;
            rawText = (retry.content ?? "").trim();
          } else {
            return done({
              reply: `模型连着两次都没给出能用的输出，这一轮什么都没做。\n\n上一次是：\n${String(
                retry.content || "（空）"
              ).slice(0, 240)}\n\n可以再试一次，或到「设置 → 测试连接」看看模型状态。`,
              error: "模型输出不可用",
            });
          }
        } catch (e) {
          return done({
            reply: `模型这次没给出能用的输出：${humanError(String(e))}\n\n这一轮什么都没改。`,
            error: String(e),
          });
        }
      } else {
        degraded = true;
      }
    }
  } catch (e) {
    // 用户点了停止：这不是失败，别挂上"模型调用失败"的帽子
    if (String(e).includes(CANCELLED)) throw e;
    const msg = humanError(String(e));
    if (!hasModelKey) {
      log("warn", "尚未配置对话模型，使用本地演示工作流");
      degraded = true;
    } else {
      log("error", `模型调用失败：${msg}`);
      return done({
        reply: `模型调用失败，这一轮没有生成任何东西。\n\n${msg}\n\n到「设置」核对 Base URL / Key / 模型 ID，再点「测试连接」确认。`,
        error: msg,
        degraded: false,
      });
    }
  }

  // 纯对话：模型明确表示这只是聊天，不要编计划、不要跑演示图
  if (parsed?.chat) {
    const chatReply = String(parsed.reply ?? "").trim();
    return done({ reply: chatReply || "嗯。", degraded });
  }
  // 没带 chat 字段但也没有 plan/ops/graph —— 同样按对话处理
  if (
    parsed &&
    !parsed.plan &&
    !Array.isArray(parsed.ops) &&
    parsed.graph === undefined &&
    !Array.isArray(parsed.shots)
  ) {
    const chatReply = String(parsed.reply ?? "").trim();
    if (chatReply) return done({ reply: chatReply, degraded });
  }

  if (!parsed) {
    // 走到这里只剩「根本没配对话模型」：用本地工作流保证链路可玩，
    // 但只要配了 Key 就一定走上面的报错分支，不拿占位图糊弄人。
    parsed = {
      reply:
        "现在还没有接入对话模型，我先用一个本地占位工作流把链路跑通——这张图是内核真实执行出来的，不是假图。配置好模型之后，同一套流程会换成真实生成。",
      graph: demoGraph(),
    };
  }

  /* --------------------------- 画布共编：ops 路径 --------------------------- */
  const opsPayload = Array.isArray(parsed?.ops) && parsed.ops.length ? parsed.ops : null;
  if (opsPayload) {
    if (!opts.lastGraph) {
      return done({
        reply: "当前画布上还没有图——先拍一个镜头，我就能直接在图上动手了。",
        degraded,
      });
    }
    stage("应用画布操作");
    const opsAt = Date.now();
    const opsId = newStepId();
    cb.onStep?.({ id: opsId, kind: "tool", title: "应用画布操作", status: "running" });
    const ctx = {
      cardOf: (ct: string) => {
        const c = NODE_INDEX.get(ct);
        return c ? { display: c.d, in: c.in, out: c.out } : undefined;
      },
    };
    const { graph: edited, applied, errors } = applyGraphOps(opts.lastGraph, opsPayload, ctx);
    for (const a of applied) log("info", `画布操作：${a}`);
    for (const e of errors) log("error", e);
    cb.onStep?.({
      id: opsId,
      kind: "tool",
      title: "应用画布操作",
      status: errors.length ? "error" : "done",
      note: `${applied.length} 处 · ${((Date.now() - opsAt) / 1000).toFixed(1)}s`,
      detail: [...applied, ...errors].join("\n"),
    });

    stage("校验修改后的图");
    const vId = newStepId();
    cb.onStep?.({ id: vId, kind: "tool", title: "校验连线与类型", status: "running" });
    const { graph: checked, errors: vErrors, repairs } = validateAndRepair(edited);
    if (repairs.length) log("info", `自动修正：${repairs.join("；")}`);
    cb.onStep?.({
      id: vId,
      kind: "tool",
      title: "校验连线与类型",
      status: vErrors.length ? "error" : "done",
      note: vErrors.length ? `${vErrors.length} 个问题` : "通过",
      detail: vErrors.join("\n") || undefined,
    });
    /* 交货前先自检：这张图真能跑吗？跑不起来就自己修，修不好就退回原图 */
    const baseline = new Set(
      [...errors, ...vErrors, ...auditGraph(opts.lastGraph).filter((i: AuditIssue) => i.level === "error").map((i) => i.text)]
    );
    let finalGraph = checked;
    let fixRounds = 0;
    const freshProblems = (g: ComfyGraph) =>
      [...errors, ...vErrors, ...auditGraph(g).filter((i: AuditIssue) => i.level === "error").map((i) => i.text)].filter(
        (p) => !baseline.has(p)
      );
    let problems = freshProblems(finalGraph);

    while (problems.length && fixRounds < 2 && hasModelKey) {
      fixRounds++;
      stage(`自检没过，修第 ${fixRounds} 轮`);
      const fixId = newStepId();
      cb.onStep?.({
        id: fixId,
        kind: "tool",
        title: `自检没过，修第 ${fixRounds} 轮`,
        status: "running",
        detail: problems.join("\n"),
      });
      let fixOps: any[] = [];
      try {
        const fixResp = await llmJsonChat(
          [
            ...messages,
            { role: "assistant", content: rawText },
            {
              role: "user",
              content: `你上一轮改完的图跑不起来，问题在这：\n- ${problems.join("\n- ")}\n\n现在的图：\n${JSON.stringify(
                finalGraph
              )}\n\n只输出 {"reply":"一句话","ops":[...]}，用 ops 把这些问题改掉；不要输出 plan，不要解释。`,
            },
          ],
          cb,
          `自查修复 ${fixRounds}`
        );
        const fixParsed = parseJsonLoose(fixResp.content);
        fixOps = Array.isArray(fixParsed?.ops) ? fixParsed.ops : [];
        llmTokens += fixResp.tokens;
      } catch (e) {
        log("warn", `自查修复调用失败：${e}`);
      }
      if (!fixOps.length) {
        cb.onStep?.({
          id: fixId,
          kind: "tool",
          title: `自检没过，修第 ${fixRounds} 轮`,
          status: "error",
          note: "模型没给出可用的修正",
        });
        break;
      }
      const fixed = applyGraphOps(finalGraph, fixOps, ctx);
      const rev = validateAndRepair(fixed.graph);
      finalGraph = rev.graph;
      problems = freshProblems(finalGraph);
      cb.onStep?.({
        id: fixId,
        kind: "tool",
        title: `自检没过，修第 ${fixRounds} 轮`,
        status: problems.length ? "error" : "done",
        note: `${fixOps.length} 条操作 · ${problems.length ? `还剩 ${problems.length} 个问题` : "修好了"}`,
      });
    }

    // 还是跑不起来：不许假装改好了，画布退回改之前
    if (problems.length) {
      return done({
        reply: `${String(parsed.reply || "").trim()}\n\n这版我没改对：${problems[0]}${
          fixRounds ? `（已经自己修了 ${fixRounds} 轮还是不行）` : ""
        }\n\n画布保持原样，没动你的图。换个说法再来一次，或者直接告诉我该怎么接。`,
        graph: opts.lastGraph,
        graphEdited: false,
        degraded,
        error: problems[0],
      });
    }

    if (!applied.length) {
      return done({
        reply: `${String(parsed.reply || "").trim()}\n\n但我这边没有一条改动真正落到图上——可能需要换种说法，或者你说清要改哪个节点。`,
        graph: finalGraph,
        graphEdited: false,
        degraded,
      });
    }

    const fixedNote = fixRounds ? `（自检修了 ${fixRounds} 轮）` : "";
    const reply = `${String(parsed.reply || "").trim()}\n\n已改 ${applied.length} 处：${applied
      .slice(0, 6)
      .join("；")}${applied.length > 6 ? "…" : ""}${fixedNote}\n\n改动已放到画布上，看完点「开始生成」。`;

    // 结构能跑 ≠ 语义没错：把新冒出来的警告（比如把 URL 填进了普通字段）捎给用户看
    const warnBaseline = new Set(
      auditGraph(opts.lastGraph)
        .filter((i: AuditIssue) => i.level === "warn")
        .map((i) => i.text)
    );
    const freshWarns = auditGraph(finalGraph)
      .filter((i: AuditIssue) => i.level === "warn" && !warnBaseline.has(i.text))
      .slice(0, 2);

    return done({
      reply: freshWarns.length ? `${reply}\n\n提醒：${freshWarns.map((w) => w.text).join("；")}` : reply,
      graph: finalGraph,
      graphEdited: true,
      degraded,
    });
  }

  /* ----------------------------- 计划路径 ----------------------------- */
  const planPayload = parsed?.plan ?? (parsed?.shots ? parsed : null);
  if (planPayload) {
    let plan: DramaPlan;
    try {
      const parsedPlan = parsePlan(planPayload);
      plan = parsedPlan.plan;
      for (const w of parsedPlan.warnings) log("warn", w);
    } catch (e) {
      // 计划不完整时不要吞掉模型的回答：当普通对话展示
      const chatReply = String(parsed.reply ?? "").trim();
      log("warn", `计划解析失败，按对话处理：${e}`);
      if (chatReply) {
        return done({ reply: chatReply, degraded: true });
      }
      return done({
        reply: `计划解析失败：${e}`,
        degraded: true,
        error: String(e),
      });
    }

    const { plan: finalPlan, warnings: budgetWarnings } = applyBudget(plan, opts.budget);
    for (const w of budgetWarnings) log("warn", w);

    const stats = planStats(finalPlan);
    const withVideo = hasArkKey && finalPlan.mode === "video";
    cb.onStep?.({
      id: newStepId(),
      kind: "tool",
      title: "生成分镜计划",
      status: "done",
      note: `${stats.shots} 镜 · 约 ${stats.seconds}s · ${stats.characters} 角色`,
      detail: JSON.stringify(finalPlan, null, 2).slice(0, 6000),
    });
    log(
      "info",
      `计划：${finalPlan.title}｜${stats.characters} 角色｜${stats.shots} 镜｜约 ${stats.seconds}s｜${
        withVideo ? "图 + 视频" : "仅分镜图"
      }`
    );

    const suffix = `\n\n${stats.shots} 个镜头 · 约 ${stats.seconds} 秒${
      withVideo ? "" : "（仅分镜图）"
    }`;
    const reply = `${parsed.reply || "计划好了。"}${suffix}`;

    // 确认门：会花钱的执行都先停下来等用户点头
    if (hasArkKey && opts.confirmBeforeRun) {
      return done({
        reply: `${reply}\n\n图已经搭到画布上了，看一眼；觉得对就点画布上的「开始生成」。`,
        plan: finalPlan,
        append: parsed.append === true,
        degraded,
        needsConfirm: true,
        usage: { llmTokens, images: 0, videoSeconds: 0 },
      });
    }

    return done(
      await compileAndRun(
        finalPlan,
        {
          hasArkKey,
          imageModel: opts.imageModel,
          imageSize: opts.imageSize,
          videoModel: opts.videoModel,
          videoResolution: opts.videoResolution,
          generateAudio: opts.generateAudio,
          llmTokens,
        },
        client,
        cb,
        { reply, degraded }
      )
    );
  }

  /* --------------------------- 兼容旧的图路径 --------------------------- */
  if (parsed.graph === null || parsed.graph === undefined) {
    return done({
      reply: parsed.reply || "当前能力还做不到这个需求。",
      degraded,
    });
  }

  stage("校验工作流");
  const { graph, errors, repairs } = validateAndRepair(parsed.graph);
  if (repairs.length) log("info", `自动修正：${repairs.join("；")}`);
  if (errors.length) {
    log("error", `校验未通过：${errors.join("；")}`);
    return done({
      reply: `${parsed.reply || ""}\n\n工作流没通过校验：${errors[0]}`,
      graph,
      degraded,
      error: errors.join("；"),
    });
  }

  if (!client) {
    return done({
      reply: `${parsed.reply || ""}\n\n（内核未就绪，工作流已生成但未执行）`,
      graph,
      degraded,
    });
  }

  const blocking = auditGraph(graph).filter((i: AuditIssue) => i.level === "error");
  if (blocking.length) {
    log("error", `审计未通过：${blocking[0].text}`);
    return done({
      reply: `${String(parsed.reply || "").trim()}\n\n这版图跑不起来：${blocking[0].text}\n\n画布没动。`,
      degraded,
      error: blocking[0].text,
    });
  }
  if (hasArkKey && !hasGenerator(graph)) {
    return done({
      reply: `${String(parsed.reply || "").trim()}\n\n（这版图里没有真正调用模型的节点，只有占位画面，跑出来是空的——所以没放到画布上。说清要什么内容，我重新搭。）`,
      degraded,
      error: "没有生成节点",
    });
  }

  // 画布是唯一的执行入口：这里只把图交上去，点不点「开始生成」由人决定
  return done({
    reply: `${String(parsed.reply || "").trim()}\n\n图已经放到画布上了（${Object.keys(graph).length} 个节点），看完点「开始生成」。`,
    graph,
    graphEdited: true,
    degraded,
  });
}

/** 节点库概览，用于界面上展示 */
export function librarySummary(): string {
  const parts = [`可用 ${LIB_STATS.usable}`, `需权重 ${LIB_STATS.needWeights}`, `第三方 ${LIB_STATS.partner}`];
  let s = parts.join(" · ");
  if (MISSING_CORE.length) s += `（缺 ${MISSING_CORE.length} 个核心节点）`;
  return s;
}
