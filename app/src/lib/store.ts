import { create } from "zustand";
import type {
  AppConfig,
  Asset,
  ChatMessage,
  ChatSession,
  ChatStep,
  ComfyGraph,
  ComfyStatus,
  DramaPlan,
  DramaShot,
  EnvReport,
  LogEntry,
  RunRecord,
  RunUsage,
  ProjectMeta,
} from "../types";
import * as api from "./api";
import { mergeShotAssets, mergeShotCost, mergeShotGraph, remapShotAssets, remapShotGraph } from "./shot-merge";

/** 和 media.ts 里的同名函数同一套规则：按 outDir 的分隔符风格拼绝对路径 */
const joinPath = (dir: string, ...parts: (string | undefined)[]) => {
  const sep = dir.includes("\\") ? "\\" : "/";
  const tail = parts
    .filter((p): p is string => !!p)
    .map((p) => String(p).replace(/^[\\/]+|[\\/]+$/g, ""))
    .filter(Boolean);
  return [dir.replace(/[\\/]+$/, ""), ...tail].join(sep);
};
import { compilePlan, maxShotOf, storyboardCsv } from "./plan";
import { auditGraph, blockingIssues, diffGraph } from "./graphAudit";
import type { GraphDiff } from "./graphAudit";
import type { WatchEvent } from "./comfy";
import { ComfyClient } from "./comfy";
import {
  executeEditedGraph,
  executePlanWithRepair,
  validateAndRepair,
  extractPartialReply,
  humanError,
  runAgentTurn,
} from "./agent";
import type { StepEvent } from "./agent";

export type Tab = "shots" | "graph" | "assets" | "logs";

/**
 * 画布：整个应用的唯一真相。
 * 对话只负责沟通，AI 的每一次计划/改动都落成一张图放到这里，
 * 人也在同一张图上改，执行也在这里点。
 */

/** 生成过程中某个节点此刻的状态：只活在这一次执行里，跑完就清 */
export interface NodeRun {
  s: "run" | "done" | "cache" | "err";
  /** 0–1，进度条用 */
  pct?: number;
}

export interface CanvasDoc {
  id: string;
  graph: ComfyGraph;
  plan?: DramaPlan;
  /** P1-3 双方案：备选变体，确认门上可一键互换 */
  planAlt?: DramaPlan;
  title: string;
  status: "draft" | "running" | "done" | "error";
  note?: string;
  /** AI 刚改过，画布上标出来，让人知道要看一眼 */
  fromAI?: boolean;
  /** 这一版跟上一版差在哪：画布要高亮、要能点开看 */
  change?: GraphDiff;
  /**
   * 整张图被重铺（重新编译分镜时）：节点 id 会撞上旧图，
   * 按 id 比对只能算出"改了 3 处"，看着像没干活。这里单独记一笔，
   * 让人知道旧版整个被换掉了。
   */
  rebuild?: { before: number; after: number; replaced: number };
  /** 改动发生的时刻，画布用它决定高亮多久 */
  changedAt?: number;
  ts: number;
}

interface Store {
  ready: boolean;
  env: EnvReport | null;
  config: AppConfig | null;
  comfy: ComfyStatus | null;
  /** 产物目录绝对路径：历史里的图/视频直接读磁盘，引擎关了也看得见 */
  outDir: string | null;
  starting: boolean;
  messages: ChatMessage[];
  runs: RunRecord[];
  logs: LogEntry[];
  busy: boolean;
  stage: string;
  /** 正在流式接收的那条助手消息 id（同时用于暂停落盘） */
  streamingId: string | null;
  tab: Tab;
  error: string | null;
  /** 最近一轮发给模型的系统提示词，供人工审查 */
  lastPrompt: string | null;
  /** 画布上「＋N 可选」被手动展开的节点：随工程走（以前只存本机） */
  expandedIds: string[];
  setExpandedIds: (ids: string[]) => void;
  /** 多会话：每个会话有独立的消息流与执行历史 */
  sessions: ChatSession[];
  activeId: string;
  /** 当前画布（永不为空）：AI 与人共用的同一份图 */
  draft: CanvasDoc;
  /** 画布要看的那个节点（点了报错、点了改动条目都会设） */
  focus: { id: string; at: number } | null;
  focusNode: (id: string) => void;
  /** 生成中：每个节点此刻在跑/跑完/缓存/出错，画布据此点亮 */
  runNodes: Record<string, NodeRun>;
  /** 当前正在跑的节点 id，工具栏显示用 */
  runNow: string | null;
  /** 用户点了停止：等所有 await 点自己收手 */
  cancelRequested: boolean;
  cancelRun: () => Promise<void>;
  /** 停掉正在跑的这一轮对话（掐断模型输出，画布不动） */
  stopTurn: () => Promise<void>;

  /** 引擎空闲多久自动停（分钟），0 = 不自动停 */
  idleStopMin: number;
  /** 已排上自动停的时间点（null = 没排） */
  idleStopAt: number | null;
  /** 跑完之后挂一个空闲计时：开着就吃显存，人走了不该一直烧着 */
  armIdleStop: () => void;
  disarmIdleStop: () => void;
  setIdleStopMin: (min: number) => void;

  /** 内部：确保内核就绪（常驻，瞬时完成） */
  ensureComfy: () => Promise<boolean>;
  init: () => Promise<void>;
  refreshComfy: () => Promise<void>;
  startComfy: () => Promise<void>;
  stopComfy: () => Promise<void>;
  send: (text: string) => Promise<void>;
  /** 人在画布上改图 */
  setDraftGraph: (g: ComfyGraph) => void;
  /** 执行当前画布（唯一的生成入口） */
  runDraft: () => Promise<void>;
  /** P1-3 双方案：A/B 两版互换（plan ↔ planAlt），换完重编译画布 */
  swapPlanVariant: () => void;
  /** 丢掉画布改动，回到最近一次执行的那张图 */
  resetDraft: () => void;
  rerunShot: (runId: string, shotIndex: number) => Promise<void>;
  /** 拖动分镜卡改出片顺序：只动这一版的展示与合成顺序，不重跑、不动文件 */
  moveShot: (runId: string, from: number, to: number) => void;
  resetShotOrder: (runId: string) => void;
  rerunGraph: (runId: string, graph: ComfyGraph) => Promise<void>;
  /** 把一次计划里的所有镜头视频合成成片 */
  assembleShots: (runId: string) => Promise<void>;
  /** 删除一条执行记录（产物文件保留在磁盘） */
  deleteRun: (runId: string) => void;
  /** 在资源管理器里打开输出目录 */
  openOutputDir: () => Promise<void>;
  switchSession: (id: string) => void;
  newSession: () => void;
  deleteSession: (id: string) => void;

  /** 项目（工程文件夹）：一个项目一个真实文件夹，装着画布和多条会话 */
  projects: ProjectMeta[];
  project: ProjectMeta | null;
  refreshProjects: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  createProject: (name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  /** 在资源管理器里打开当前项目文件夹 */
  openProjectFolder: () => Promise<void>;
  /** 切换项目根目录（旧根下的当前项目先落盘；新根有同名项目就接着用） */
  setProjectsRoot: (path: string) => Promise<void>;
  /** 导出一条记录的成片（没有成片就导出分镜视频）到项目的 export/ 文件夹 */
  exportRunAssets: (runId: string) => Promise<void>;
  /** 把这一版的分镜表（镜号/景别/运镜/台词/时长）导出成 CSV，进项目 export/ */
  exportStoryboard: (runId: string) => Promise<void>;
  /** 把 output/ 里没被任何执行记录引用的冒烟测试产物移进 _trash（不真删） */
  cleanupTestOutputs: () => Promise<void>;
  /** 自我完善：把一条经验沉淀进配置，之后出计划都会带上 */
  addLearning: (lesson: string) => Promise<void>;
  clearLearnings: () => Promise<void>;
  /** 删除单条经验（设置页手动编辑） */
  removeLearning: (index: number) => Promise<void>;
  /** 内部：执行结果统一落一条助手消息（不暴露给组件） */
  runAndAnnounce: (
    promise: Promise<{ reply: string; run?: RunRecord; graph?: ComfyGraph; error?: string }>,
    msgId?: string
  ) => Promise<void>;
  addLog: (level: LogEntry["level"], text: string) => void;
  clearLogs: () => void;
  setTab: (t: Tab) => void;
  saveConfig: (patch: Partial<AppConfig>) => Promise<void>;
  clearError: () => void;
}

const client = (_config: AppConfig | null, _comfy: ComfyStatus | null) => {
  // 原生内核常驻：不再看引擎进程的脸色，任何时刻都能提交
  return new ComfyClient();
};

const SESSIONS_KEY = "storyforge.sessions.v2";

/** agent.ts 里用来表示"人点了停止"的哨兵串，不是真错误 */
const STOP_SENTINEL = "__cancelled_by_user__";

const WELCOME_TEXT =
  "我是你的导演台。说一句你想拍的东西，我就把分镜图搭到右边的画布上——不在这里报参数，你直接看画布、改画布，觉得对了点「开始生成」，我就逐镜跑。生成内核常驻，随到随跑。\n\n还没接生成模型也能试：直接说「先来一张测试画面」，我用本地工作流在画布上真跑一张给你看。想自己搭节点，切到「工作流」页就能玩。";

const welcome = (): ChatMessage => ({
  id: uid(),
  role: "assistant",
  content: WELCOME_TEXT,
  ts: Date.now(),
});

const freshSession = (): ChatSession => ({
  id: uid(),
  title: "新对话",
  messages: [welcome()],
  runs: [],
  lastPrompt: null,
});

const starterDoc = (): CanvasDoc => ({
  id: "scratch",
  title: "空白画布",
  status: "draft",
  ts: 0,
  graph: {
    "1": {
      class_type: "EmptyImage",
      inputs: { width: 720, height: 1280, batch_size: 1, color: 0x1b2430 },
      _meta: { title: "空白画面" },
    },
    "2": {
      class_type: "SaveImage",
      inputs: { images: ["1", 0], filename_prefix: "storyforge/scratch" },
      _meta: { title: "保存" },
    },
  },
});

/** 从产物反推用量：这一版没有 LLM 开销，图和视频秒数按产物数出来 */
const usageFromAssets = (assets: Asset[]): RunUsage => {
  const isVid = (a: Asset) => /\.(mp4|webm|mov|mkv)(?:[?&#]|$)/i.test(a.filename || "");
  return {
    llmTokens: 0,
    images: assets.filter((a) => !isVid(a)).length,
    videoSeconds: Math.round(assets.reduce((n, a) => n + (a.duration || 0), 0) * 10) / 10,
  };
};

/** 一条执行记录 → 画布：执行完就把画布切到这张"已经是结果"的图上 */
const docFromRun = (run: RunRecord): CanvasDoc => ({
  id: run.id,
  graph: run.graph,
  plan: run.plan,
  title: run.plan?.title || "已执行的图",
  status: run.status === "queued" || run.status === "running" ? "running" : run.status,
  note: run.note,
  ts: run.startedAt,
});

function persistSessions(s: Store) {
  try {
    localStorage.setItem(
      SESSIONS_KEY,
      JSON.stringify({
        activeId: s.activeId,
        sessions: s.sessions.slice(-30),
        draft: s.draft,
      })
    );
  } catch {
    /* 存储满 / 不可用时不影响使用 */
  }
}

/** 当前状态 → project.json 内容（没有打开的项目时返回 null） */
function snapshotOf(s: Store): string | null {
  if (!s.project) return null;
  return JSON.stringify(
    {
      schemaVersion: 1,
      id: s.project.id,
      name: s.project.name,
      draft: s.draft,
      sessions: s.sessions,
      activeId: s.activeId,
      lastPrompt: s.lastPrompt,
      expanded: s.expandedIds,
      savedAt: Date.now(),
    },
    null,
    2
  );
}

/** 落盘防抖：对话流式输出时一秒几十次变更，800ms 内合并成一次写 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveProjectSoon(s: Store) {
  const json = snapshotOf(s);
  if (!json) return;
  const id = s.project!.id;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void api
      .projectSave(id, json)
      .catch((e) => useStore.getState().addLog("warn", `项目保存失败：${e}`));
  }, 800);
}

/** 项目最近打开指针（真正的项目数据在磁盘 project.json 里，这里只记 id） */
const PROJECT_POINTER_KEY = "storyforge.project.v1";

/**
 * 把任意来源（localStorage 旧档 / project.json）的会话+画布数据清洗成可用状态：
 * 产物 URL 的端口按当前配置重写、坏消息清掉、非法 run 过滤。
 */
function sanitizeLoaded(
  data: any,
  port: number
): { sessions: ChatSession[]; activeId: string; draft: CanvasDoc; expanded: string[] | null } | null {
  try {
    const rebase = (u: string) =>
      String(u).replace(/127[.]0[.]0[.]1:[0-9]+/, `127.0.0.1:${port}`);
    const validRun = (r: RunRecord) =>
      r && typeof r === "object" && r.graph && typeof r.graph === "object";
    const sessions: ChatSession[] = (data.sessions ?? [])
      .map((x: ChatSession) => ({
        ...x,
        messages: (x.messages ?? [])
          .filter((m: ChatMessage) => m && typeof m.content === "string")
          // 老版本任何失败都会降级到占位图并打上 degraded，这条路径已经删了；
          // 历史消息里的标记是坏的旧状态，读进来时清掉，别让人以为现在还在演示
          .map((m: ChatMessage) =>
            m.meta?.degraded ? { ...m, meta: { ...m.meta, degraded: false } } : m
          )
          // 更早的版本把"人点了停止"当成失败写进消息里，哨兵串就留在历史上了；
          // 读回来时纠正成一句正常的话，别让旧记录看起来像出了故障
          .map((m: ChatMessage) =>
            String(m.content ?? "").includes(STOP_SENTINEL)
              ? {
                  ...m,
                  content: "已经停了，画布没动。",
                  kind: "text" as const,
                  streaming: false,
                  steps: (m.steps ?? []).map((s) =>
                    s.status === "running"
                      ? { ...s, status: "done" as const, endedAt: s.endedAt ?? Date.now() }
                      : s
                  ),
                }
              : m
          ),
        runs: (x.runs ?? []).filter(validRun).map((r: RunRecord) => ({
          ...r,
          assets: (r.assets ?? []).map((a: any) => ({
            ...a,
            url: rebase(a.url),
          })),
        })),
      }))
      .filter((x: ChatSession) => x.id && Array.isArray(x.messages));
    if (!sessions.length) return null;
    // 兼容老版本存下的 scratch（那时候画布只是一张空白图）
    const rawDraft = data.draft ?? data.scratch;
    const draft: CanvasDoc =
      rawDraft && rawDraft.graph && typeof rawDraft.graph === "object"
        ? {
            id: String(rawDraft.id || "scratch"),
            graph: rawDraft.graph,
            plan: rawDraft.plan,
            title: rawDraft.title || rawDraft.plan?.title || "空白画布",
            status: rawDraft.status === "done" || rawDraft.status === "error" ? rawDraft.status : "draft",
            note: rawDraft.note,
            fromAI: !!rawDraft.fromAI,
            ts: Number(rawDraft.ts) || 0,
          }
        : starterDoc();
    return {
      sessions,
      activeId: sessions.some((x) => x.id === data.activeId)
        ? data.activeId
        : sessions[sessions.length - 1].id,
      draft,
      // 折叠状态以前只存本机 localStorage；现在随工程走，老档没有就返回 null 让调用方迁移
      expanded: Array.isArray(data.expanded)
        ? data.expanded.filter((x: unknown): x is string => typeof x === "string")
        : null,
    };
  } catch {
    return null;
  }
}

/** 旧版折叠状态只存在本机 localStorage：迁移一次进工程，读完即清 */
function seedExpandedFromLocal(): string[] {
  try {
    const raw = localStorage.getItem("sf.expand");
    if (raw === null) return [];
    localStorage.removeItem("sf.expand");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function loadPersisted(
  port: number
): { sessions: ChatSession[]; activeId: string; draft: CanvasDoc; expanded: string[] | null } | null {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return null;
    return sanitizeLoaded(JSON.parse(raw), port);
  } catch {
    return null;
  }
}

let initStarted = false;

const uid = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

export const useStore = create<Store>((set, get) => {
  const initialSession = freshSession();

  /** 空闲自动停的计时器：放模块级，切页面也不会重复挂 */
  let idleTimer: number | null = null;
  /** 这个偏好只跟本机有关，存本地就行，不进后端配置 */
  const IDLE_KEY = "sf.idleStopMin";
  const savedIdle = (() => {
    try {
      const v = localStorage.getItem(IDLE_KEY);
      const n = v === null ? NaN : Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 5;
    } catch {
      return 5;
    }
  })();

  /* ---------------- 流式一轮回复的辅助 ---------------- */

  const patchMsg = (id: string, fn: (m: ChatMessage) => ChatMessage) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? fn(m) : m)) }));

  const applyStep = (msgId: string, step: StepEvent) =>
    patchMsg(msgId, (m) => {
      const steps = m.steps ? [...m.steps] : [];
      const i = steps.findIndex((x) => x.id === step.id);
      const prev = i >= 0 ? steps[i] : undefined;
      const merged: ChatStep = {
        id: step.id,
        kind: step.kind,
        title: step.title,
        status: step.status,
        detail: step.detail ?? prev?.detail,
        note: step.note ?? prev?.note,
        startedAt: prev?.startedAt ?? Date.now(),
        endedAt: step.status === "running" ? undefined : Date.now(),
      };
      if (i >= 0) steps[i] = merged;
      // 思考永远排最前：它是这一轮最早发生的事，条目却是最后一个被创建的
      else if (step.kind === "think") steps.unshift(merged);
      else steps.push(merged);
      return { ...m, steps };
    });

  /** 先插一条空消息占位，后面靠 onDelta 往里写，用户能立刻看到东西在动 */
  const beginTurn = (): string => {
    const id = uid();
    const msg: ChatMessage = {
      id,
      role: "assistant",
      content: "",
      ts: Date.now(),
      streaming: true,
      steps: [],
    };
    set((s) => ({ messages: [...s.messages, msg], streamingId: id }));
    return id;
  };

  const endTurn = (
    id: string,
    o: { reply: string; error?: string; degraded?: boolean; graph?: ComfyGraph }
  ) => {
    patchMsg(id, (m) => ({
      ...m,
      content: o.reply || m.content,
      kind: o.error ? "error" : "text",
      streaming: false,
      meta: { degraded: !!o.degraded, graph: o.graph },
      steps: m.steps?.map((s) =>
        s.status === "running" ? { ...s, status: "done" as const, endedAt: Date.now() } : s
      ),
    }));
    set({ streamingId: null });
  };

  /**
   * 内核进度事件 → 画布上的节点状态。
   * 生成那几分钟里，人得看得见"现在跑到哪个节点、跑了多少"，
   * 而不是盯着一行「生成中」等。
   */
  const applyNodeEvent = (e: WatchEvent) => {
    const cur = get().runNodes;
    const prev = get().runNow;
    switch (e.kind) {
      case "start":
        set({ runNodes: {}, runNow: null });
        return;
      case "node": {
        const next: Record<string, NodeRun> = { ...cur };
        // 换到下一个节点，说明上一个已经跑完了
        if (prev && next[prev]?.s === "run") next[prev] = { s: "done", pct: 1 };
        if (e.node) {
          next[e.node] = { s: "run", pct: 0 };
          set({ runNodes: next, runNow: e.node });
        }
        return;
      }
      case "progress": {
        if (!e.node) return;
        const old = cur[e.node];
        const pct = e.pct ?? 0;
        // 采样步进很密，涨不到 2% 就不惊动画布
        if (old && old.s === "run" && Math.abs((old.pct ?? 0) - pct) < 0.02) return;
        set({ runNodes: { ...cur, [e.node]: { s: "run", pct } } });
        return;
      }
      case "nodeDone":
        if (!e.node) return;
        set({ runNodes: { ...cur, [e.node]: { s: "done", pct: 1 } } });
        return;
      case "cached": {
        const next: Record<string, NodeRun> = { ...cur };
        for (const id of e.nodes || []) next[id] = { s: "cache" };
        set({ runNodes: next });
        return;
      }
      case "done":
        set({
          runNodes: Object.fromEntries(
            Object.entries(cur).map(([k, v]) => [k, v.s === "run" ? { s: "done", pct: 1 } : v])
          ),
          runNow: null,
        });
        return;
      case "error": {
        const next: Record<string, NodeRun> = { ...cur };
        if (e.node) next[e.node] = { s: "err" };
        set({ runNodes: next, runNow: null });
        return;
      }
      default:
        return;
    }
  };

  /** 一轮里的 delta / step 落点：正文边生成边显示，思考单独累积 */
  const makeHandlers = (msgId: string) => {    let raw = "";
    let thinkId: string | null = null;
    return {
      onDelta: (kind: "content" | "reasoning", text: string) => {
        if (kind === "reasoning") {
          if (!thinkId) {
            thinkId = uid();
            applyStep(msgId, { id: thinkId, kind: "think", title: "思考", status: "running" });
          }
          patchMsg(msgId, (m) => ({ ...m, thinking: (m.thinking || "") + text }));
          return;
        }
        if (thinkId) {
          applyStep(msgId, { id: thinkId, kind: "think", title: "思考", status: "done" });
          thinkId = null;
        }
        raw += text;
        const partial = extractPartialReply(raw);
        if (partial) patchMsg(msgId, (m) => ({ ...m, content: partial }));
      },
      onStep: (step: StepEvent) => applyStep(msgId, step),
      onNode: (e: WatchEvent) => applyNodeEvent(e),
    };
  };

  return {
  ready: false,
  env: null,
  config: null,
  comfy: null,
  outDir: null,
  starting: false,
  idleStopMin: savedIdle,
  idleStopAt: null,
  runNodes: {},
  runNow: null,
  messages: initialSession.messages,
  runs: [],
  logs: [],
  busy: false,
  stage: "",
  streamingId: null,
  tab: "graph",
  error: null,
  lastPrompt: null,
  expandedIds: [],
  sessions: [initialSession],
  activeId: initialSession.id,
  projects: [],
  project: null,
  draft: starterDoc(),
  focus: null,
  cancelRequested: false,

  addLog: (level, text) =>
    set((s) => ({
      logs: [...s.logs, { ts: Date.now(), level, text }].slice(-300),
    })),

  clearLogs: () => set({ logs: [] }),

  setTab: (tab) => set({ tab }),
  clearError: () => set({ error: null }),

  setExpandedIds: (ids) => {
    set({ expandedIds: [...new Set(ids)].slice(0, 200) });
    // 全局订阅只盯 messages/runs/draft，折叠状态的变化要自己触发落盘
    if (get().project) saveProjectSoon(get());
  },

  init: async () => {
    // StrictMode 下 effect 会连跑两次：第二次直接返回，别把初始化做重
    if (initStarted) return;
    initStarted = true;
    try {
      const config = await api.getConfig();
      const [env, comfy] = await Promise.all([api.envCheck(), api.comfyStatus()]);
      // 恢复上次的多会话历史；产物 URL 里的端口可能已变，按当前配置重写
      const persisted = loadPersisted(config?.comfyPort ?? 8188);
      if (persisted) {
        const active =
          persisted.sessions.find((x) => x.id === persisted.activeId) ??
          persisted.sessions[persisted.sessions.length - 1];
        set({
          sessions: persisted.sessions,
          activeId: active.id,
          messages: active.messages,
          runs: active.runs,
          lastPrompt: active.lastPrompt ?? null,
          // 折叠状态：工程档里有就用；老档没有就从 localStorage 迁移一次
          expandedIds: persisted.expanded ?? seedExpandedFromLocal(),
          // 上次的"AI 刚改过"是上一场的事：重启后不该还挂着，
          // 也不该把"正在跑"残留成真的在跑
          draft: persisted.draft
            ? {
                ...persisted.draft,
                status: persisted.draft.status === "running" ? "draft" : persisted.draft.status,
                fromAI: false,
                change: undefined,
                rebuild: undefined,
                changedAt: undefined,
              }
            : persisted.draft,
        });
      }
      set({ config, env, comfy, ready: true });

      // ---- 项目引导：磁盘上有项目就打开上次的；一个都没有就把当前数据迁成「默认项目」 ----
      try {
        const list = await api.projectList();
        if (list.length) {
          const lastId = localStorage.getItem(PROJECT_POINTER_KEY);
          const target = list.find((x) => x.id === lastId) ?? list[0];
          set({ projects: list });
          await get().openProject(target.id);
        } else {
          const meta = await api.projectCreate("默认项目");
          set({ projects: [meta], project: meta });
          // 把 localStorage 时代的画布和会话原样搬进第一个项目（上面 init 已经恢复过状态）
          // 这里必须同步落盘：防抖 800ms 里再来一次 init/重启，会把空骨架当成真数据打开
          const json = snapshotOf(get());
          if (json) await api.projectSave(meta.id, json);
          localStorage.setItem(PROJECT_POINTER_KEY, meta.id);
          get().addLog("info", `已把历史数据迁移到项目「${meta.name}」`);
        }
      } catch (pe) {
        get().addLog("warn", `项目初始化失败（暂用内存模式）：${pe}`);
      }

      // 产物目录：拿到之后历史里的缩略图就能直接读磁盘，不必等引擎起来
      api
        .comfyOutputDir()
        .then((dir) => set({ outDir: dir }))
        .catch(() => set({ outDir: null }));
      // 引擎还开着（上次没关或人手动启的）：先把空闲计时挂上，别让它无声无息占着内存
      if (comfy.running) get().armIdleStop();
      get().addLog(
        "info",
        `根目录：${env.projectRoot}｜工作区：${env.comfyBaseExists ? "已就绪" : "缺失"}｜提示词：${
          env.nodesInstalled ? "已就绪" : "缺失"
        }｜ffmpeg：${env.ffmpegReady ? "已就绪" : "缺失"}`
      );
    } catch (e) {
      set({ ready: true, error: String(e) });
      get().addLog("error", `初始化失败：${e}`);
    }
  },

  refreshComfy: async () => {
    try {
      const comfy = await api.comfyStatus();
      set({ comfy });
    } catch (e) {
      get().addLog("warn", `状态查询失败：${e}`);
    }
  },

  ensureComfy: async () => {
    // 内核常驻：这一步从"等引擎起来"退化成"确认状态就绪"，瞬时完成
    if (get().comfy?.running) return true;
    try {
      await api.comfyStart();
      const comfy = await api.comfyStatus();
      set({ comfy });
      return !!comfy.running;
    } catch (e) {
      get().addLog("error", `内核状态确认失败：${e}`);
      return false;
    }
  },

  cancelRun: async () => {
    set({ cancelRequested: true, stage: "正在停止" });
    get().addLog("warn", "已点停止：正在中断当前执行");
    await get().stopComfy();
    set({ starting: false, busy: false, runNodes: {}, runNow: null, stage: "", error: null });
  },

  stopTurn: async () => {
    if (!get().busy) return;
    // 正在生成：走"断引擎"那条路（画布工具栏那个「停止」是同一个动作）
    if (get().draft.status === "running") {
      await get().cancelRun();
      return;
    }
    // 正在想 / 正在写：掐断模型输出，这一轮的改动整版作废
    set({ cancelRequested: true, stage: "正在停止" });
    get().addLog("warn", "已点停止：中断模型输出");
    await api.llmAbort();
  },

  startComfy: async () => {
    // 内核常驻，没有启动过程：确认状态即可
    try {
      await api.comfyStart();
      const comfy = await api.comfyStatus();
      set({ comfy, starting: false });
      get().addLog("info", "内核已就绪");
    } catch (e) {
      set({ starting: false, error: String(e) });
      get().addLog("error", `内核状态确认失败：${e}`);
    }
  },

  stopComfy: async () => {
    // 「停止」的真实语义：掐掉当前在跑的执行（内核没有进程可停）
    get().disarmIdleStop();
    set({ starting: false });
    try {
      await api.comfyStop();
      get().addLog("info", "已中断当前执行");
    } catch (e) {
      get().addLog("error", `中断失败：${e}`);
    }
  },

  setIdleStopMin: (min) => {
    const v = Math.max(0, Math.min(120, Math.round(min)));
    set({ idleStopMin: v });
    try {
      localStorage.setItem(IDLE_KEY, String(v));
    } catch {
      /* 存不了就算了，下次开还是默认值 */
    }
    if (v > 0) get().armIdleStop();
    else get().disarmIdleStop();
  },

  disarmIdleStop: () => {
    if (idleTimer !== null) {
      window.clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (get().idleStopAt !== null) set({ idleStopAt: null });
  },

  armIdleStop: () => {
    // 内核时代没有进程占显存，空闲自动停退役：留函数名是为了设置页的兼容
    get().disarmIdleStop();
  },

  send: async (text) => {
    const trimmed = text.trim();
    if (!trimmed || get().busy) return;

    const userMsg: ChatMessage = { id: uid(), role: "user", content: trimmed, ts: Date.now() };
    const history = get().messages;
    set({
      messages: [...history, userMsg],
      busy: true,
      runNodes: {},
      runNow: null,
      stage: "准备中",
      error: null,
      cancelRequested: false,
    });
    const msgId = beginTurn();
    const h = makeHandlers(msgId);

    try {
      const { config, comfy, draft } = get();
      const c = client(config, comfy);
      const result = await runAgentTurn(
        trimmed,
        c,
        history,
        {
          onLog: (level, msg) => get().addLog(level, msg),
          onStage: (stage) => set({ stage }),
          onDelta: h.onDelta,
          onStep: h.onStep,
          onNode: h.onNode,
        },
        {
          hasModelKey: !!config?.llm?.apiKey,
          hasArkKey: !!config?.ark?.apiKey,
          imageModel: config?.image?.model,
          imageSize: config?.image?.size,
          videoModel: config?.video?.model,
          videoResolution: config?.video?.resolution,
          generateAudio: config?.video?.generateAudio !== false,
          lastPlan: draft.plan ?? null,
          lastGraph: draft.graph,
          confirmBeforeRun: true,
          budget: config?.budget,
          lessons: config?.memory?.learnings ?? [],
        }
      );

      endTurn(msgId, {
        reply: result.reply,
        error: result.error,
        degraded: result.degraded,
        graph: result.graph,
      });

      set((s) => {
        // 计划 / 画布改动一律落到同一张画布上：对话只说话，图是画布的事
        let nextDraft = s.draft;
        let publishError: string | null = null;
        if (result.plan) {
          // 增量追加：用户说"加一镜"，只把新镜并进现有画布，不整版重铺。
          // 前提：画布上确实有一版分镜（有 plan、有 shot_N_ 节点）。
          const basePlan = result.append ? s.draft.plan : null;
          const appending = !!basePlan && maxShotOf(s.draft.graph) > 0;
          const prevGraph = s.draft.graph;
          let compiled: ComfyGraph;

          if (appending) {
            const m = maxShotOf(prevGraph);
            const merged: ComfyGraph = { ...prevGraph };
            // 旧末镜还没有尾帧节点就补一个，新第一镜的衔接参考才有处接
            let prevTail: string | undefined;
            if (!!config?.ark?.apiKey && result.plan.mode === "video" && merged[`shot_${m}_video`]) {
              prevTail = `shot_${m}_tail`;
              if (!merged[prevTail]) {
                merged[prevTail] = {
                  class_type: "DramaContinuity",
                  inputs: { video: [`shot_${m}_video`, 0] },
                  _meta: { title: `镜头 ${m} 尾帧` },
                };
              }
            }
            // 同名角色复用旧图里的定妆节点，不重复生成
            const reuseChars = new Map<string, string>();
            for (const [id, node] of Object.entries(prevGraph)) {
              if (/^char_/.test(id)) {
                const name = String((node.inputs as Record<string, unknown>)?.name ?? "");
                if (name) reuseChars.set(name, id);
              }
            }
            compiled = {
              ...merged,
              ...compilePlan(result.plan, {
                imageModel: config?.image?.model ?? "",
                imageSize: config?.image?.size ?? "1080x1920",
                videoModel: config?.video?.model ?? "",
                videoResolution: config?.video?.resolution ?? "720p",
                generateAudio: config?.video?.generateAudio !== false,
                withVideo: !!config?.ark?.apiKey && result.plan.mode === "video",
                continuity: true,
                startShot: m + 1,
                prevTail,
                reuseChars,
              }),
            };
          } else {
            compiled = compilePlan(result.plan, {
              imageModel: config?.image?.model ?? "",
              imageSize: config?.image?.size ?? "1080x1920",
              videoModel: config?.video?.model ?? "",
              videoResolution: config?.video?.resolution ?? "720p",
              generateAudio: config?.video?.generateAudio !== false,
              withVideo: !!config?.ark?.apiKey && result.plan.mode === "video",
              continuity: true,
            });
          }
          // 编译出来的图必须先证明自己能跑，才允许放到画布上
          const checked = validateAndRepair(compiled);
          const blocking = blockingIssues(auditGraph(checked.graph));
          if (blocking.length) {
            publishError = `这版分镜编译出来的图跑不起来：${blocking[0].text}。画布没动。`;
            get().addLog("error", publishError);
          } else if (appending) {
            // 合并后的计划 = 旧镜 + 新镜：镜号才能和 shot_N_ 节点对得上
            const baseNames = new Set(basePlan!.characters.map((c) => c.name));
            const mergedPlan: DramaPlan = {
              ...basePlan!,
              characters: [
                ...basePlan!.characters,
                ...result.plan.characters.filter((c) => !baseNames.has(c.name)),
              ],
              shots: [...basePlan!.shots, ...result.plan.shots],
            };
            nextDraft = {
              id: uid(),
              graph: checked.graph,
              plan: mergedPlan,
              title: `${basePlan!.title} +${result.plan.shots.length} 镜`,
              status: "draft",
              note: result.reply.split("\n")[0],
              fromAI: true,
              change: diffGraph(prevGraph, checked.graph),
              rebuild: undefined,
              changedAt: Date.now(),
              ts: Date.now(),
            };
          } else {
            // 重新编译分镜时节点 id 会撞上旧图：这其实是"整版重铺"，
            // 不能只按 id 差出"改了 3 处"，那看着像没干活
            const prevIds = Object.keys(s.draft.graph);
            const nextIds = Object.keys(checked.graph);
            const collided = nextIds.filter((id) => s.draft.graph[id]).length;
            const rebuild =
              prevIds.length && nextIds.length && collided === nextIds.length
                ? { before: prevIds.length, after: nextIds.length, replaced: collided }
                : undefined;
            nextDraft = {
              id: uid(),
              graph: checked.graph,
              plan: result.plan,
              planAlt: result.planAlt,
              title: result.plan.title,
              status: "draft",
              note: result.reply.split("\n")[0],
              fromAI: true,
              change: diffGraph(s.draft.graph, checked.graph),
              rebuild,
              changedAt: Date.now(),
              ts: Date.now(),
            };
          }
        } else if (result.graphEdited && result.graph) {
          nextDraft = {
            ...s.draft,
            graph: result.graph,
            status: "draft",
            note: result.reply.split("\n")[0],
            fromAI: true,
            change: diffGraph(s.draft.graph, result.graph),
            // 上一轮的"整版重铺"标记必须清掉，否则会被错读成这一轮也重铺了
            rebuild: undefined,
            changedAt: Date.now(),
            ts: Date.now(),
          };
        }

        return {
          draft: nextDraft,
          runs: result.run ? [result.run, ...s.runs] : s.runs,
          // 整版重铺要在对话里说清楚，别让"改了 3 处"掩盖了整张图被换掉
          messages: nextDraft.rebuild
            ? s.messages.map((m) =>
                m.id === msgId
                  ? {
                      ...m,
                      content: `${m.content}\n\n（画布上是重铺的一版：原来那 ${nextDraft.rebuild!.before} 个节点整版换掉了，新版 ${nextDraft.rebuild!.after} 个节点。不想换可以点画布右上「还原」。）`,
                    }
                  : m
              )
            : s.messages,
          // 第一条用户消息命名会话
          sessions: s.sessions.map((x) =>
            x.id === s.activeId &&
            x.messages.filter((m) => m.role === "user").length === 0
              ? { ...x, title: trimmed.slice(0, 24) }
              : x
          ),
          busy: false,
          runNodes: {},
          runNow: null,
          stage: "",
          tab: nextDraft !== s.draft ? "graph" : result.run ? "shots" : s.tab,
          error: publishError || result.error || null,
          lastPrompt: result.prompt || s.lastPrompt,
        };
      });
    } catch (e) {
      const stopped = String(e).includes(STOP_SENTINEL) || get().cancelRequested;
      endTurn(msgId, {
        reply: stopped ? "已经停了，画布没动。" : `出了点问题：${e}`,
        error: stopped ? undefined : String(e),
      });
      set({
        busy: false,
        runNodes: {},
        runNow: null,
        stage: "",
        cancelRequested: false,
        error: stopped ? null : String(e),
      });
    }
  },

  focusNode: (id) => set({ focus: { id, at: Date.now() } }),

  setDraftGraph: (g) => {
    const cur = get().draft;
    set({
      draft: {
        ...cur,
        graph: g,
        // 人一动手，这张图就回到"未执行"，按钮变成「开始生成」
        status: cur.status === "done" ? "draft" : cur.status,
        fromAI: false,
        // 也是：上一轮"AI 改了什么"的单子过期了，撤掉，别让人误读
        change: undefined,
        rebuild: undefined,
        changedAt: undefined,
        ts: Date.now(),
      },
    });
  },

  swapPlanVariant: () => {
    const { draft, config } = get();
    if (!draft.plan || !draft.planAlt || draft.status === "running") return;
    const prev = draft.plan;
    const next = draft.planAlt;
    const compiled = compilePlan(next, {
      imageModel: config?.image?.model ?? "",
      imageSize: config?.image?.size ?? "1080x1920",
      videoModel: config?.video?.model ?? "",
      videoResolution: config?.video?.resolution ?? "720p",
      generateAudio: config?.video?.generateAudio !== false,
      withVideo: !!config?.ark?.apiKey && next.mode === "video",
      continuity: true,
    });
    const checked = validateAndRepair(compiled);
    if (blockingIssues(auditGraph(checked.graph)).length) {
      get().addLog("error", "另一版编译出来跑不起来，没换。可以看对话里的风险提示让 AI 重出。");
      return;
    }
    set({
      draft: {
        ...draft,
        graph: checked.graph,
        plan: next,
        planAlt: prev,
        title: next.title,
        status: "draft",
        change: diffGraph(draft.graph, checked.graph),
        rebuild: undefined,
        fromAI: false,
        changedAt: Date.now(),
        ts: Date.now(),
      },
      runNodes: {},
      runNow: null,
      tab: "graph",
    });
    get().addLog("info", `已切到「${next.title}」，画布重编译完成；再点一次可换回「${prev.title}」。`);
  },

  runDraft: async () => {
    const doc = get().draft;
    if (get().busy) return;

    // 先自检：跑不起来的图直接拦住，把问题指到那个节点上
    const issues = blockingIssues(auditGraph(doc.graph));
    if (issues.length) {
      const first = issues[0];
      set({
        busy: false,
        runNodes: {},
        runNow: null,
        stage: "",
        error: `画布还跑不了：${first.text}`,
        focus: first.id ? { id: first.id, at: Date.now() } : get().focus,
        draft: { ...doc, status: "error", note: first.text },
      });
      const turnId = beginTurn();
      endTurn(turnId, {
        reply: `这次没执行——画布上还有 ${issues.length} 处让它跑不起来：\n\n${issues
          .slice(0, 3)
          .map((i) => `· ${i.text}`)
          .join("\n")}\n\n${first.id ? `已经把 ${first.id} 号节点指出来了，补上再点「开始生成」。` : ""}`,
        error: first.text,
      });
      return;
    }

    const t0 = Date.now();
    get().disarmIdleStop();
    // 状态跟着一起变成"生成中"：标签、按钮、节点进度说的是同一件事
    set({
      busy: true,
      runNodes: {},
      runNow: null,
      stage: "校验画布",
      error: null,
      cancelRequested: false,
      draft: { ...doc, status: "running", fromAI: false, change: undefined, rebuild: undefined, changedAt: undefined },
    });

    try {
      const ok = await get().ensureComfy();
      if (get().cancelRequested) {
        set((st) => ({
          busy: false,
          runNodes: {},
          runNow: null,
          stage: "",
          cancelRequested: false,
          draft: { ...st.draft, status: "draft" },
        }));
        endTurn(beginTurn(), { reply: "已经停了，画布保持原样。" });
        return;
      }
      if (!ok) {
        set((st) => ({
          busy: false,
          runNodes: {},
          runNow: null,
          stage: "",
          error: "内核未就绪，画布内容已保留",
          draft: { ...st.draft, status: "error" },
        }));
        return;
      }
      const { config } = get();
      const c = client(config, get().comfy);
      const turnId = beginTurn();
      const h = makeHandlers(turnId);

      // 画布即真相：执行的就是屏幕上这张图，不拿计划重新编译
      const result = await executeEditedGraph(doc.graph, c, {
        onLog: (level, msg) => get().addLog(level, msg),
        onStage: (stage) => set({ stage }),
        onDelta: h.onDelta,
        onStep: h.onStep,
        onNode: h.onNode,
      });

      endTurn(turnId, {
        reply: result.reply,
        error: result.error,
        graph: result.graph,
      });

      // 执行记录补上计划与用量：分镜页要按计划渲染，用量要能算账
      const published = result.run
        ? {
            ...result.run,
            plan: doc.plan ?? result.run.plan,
            usage: usageFromAssets(result.run.assets),
            note: result.run.note || doc.title,
          }
        : undefined;

      const cancelled = get().cancelRequested;
      set((s) => ({
        runs: cancelled ? s.runs : published ? [published, ...s.runs] : s.runs,
        cancelRequested: false,
        busy: false,
        runNodes: {},
        runNow: null,
        stage: "",
        tab: published ? "shots" : s.tab,
        error: result.error || null,
        draft: published
          ? // 执行完把状态落到同一份文档上：id 不变，画布不会突然重排
            { ...docFromRun(published), id: doc.id, plan: doc.plan, ts: t0 }
          : // 没产出记录（执行报错）也要把"生成中"收回来，别让它一直转着
            { ...s.draft, status: result.error ? "error" : "draft" },
      }));
      // 跑完就挂上空闲计时：引擎开着吃显存，人走了不该一直烧
      get().armIdleStop();
    } catch (e) {
      const stopped = get().cancelRequested;
      set((s) => ({
        busy: false,
        runNodes: {},
        runNow: null,
        stage: "",
        cancelRequested: false,
        error: stopped ? null : String(e),
        draft: stopped ? s.draft : { ...s.draft, status: "error" },
      }));
      if (stopped) {
        endTurn(beginTurn(), { reply: "已经停了，画布保持原样。" });
      } else {
        const msg = humanError(String(e));
        endTurn(beginTurn(), { reply: `执行失败：${msg}`, error: msg });
      }
    }
  },

  resetDraft: () => {
    const run = get().runs[0];
    set({ draft: run ? docFromRun(run) : starterDoc(), error: null });
  },

  // 把确认/重跑共用的"执行并落一条助手消息"收拢成一个内部流程
  async runAndAnnounce(
    promise: Promise<{ reply: string; run?: RunRecord; graph?: ComfyGraph; error?: string }>,
    msgId?: string
  ) {
    try {
      const result = await promise;
      if (msgId) {
        endTurn(msgId, {
          reply: result.reply,
          error: result.error,
          graph: result.graph,
        });
      } else {
        const assistantMsg: ChatMessage = {
          id: uid(),
          role: "assistant",
          content: result.reply,
          ts: Date.now(),
          kind: result.error ? "error" : "text",
          meta: { degraded: false, graph: result.graph },
        };
        set((s) => ({ messages: [...s.messages, assistantMsg] }));
      }
      set((s) => ({
        runs: result.run ? [result.run, ...s.runs] : s.runs,
        busy: false,
        runNodes: {},
        runNow: null,
        stage: "",
        tab: result.run ? "shots" : s.tab,
        error: result.error || null,
        // 执行完画布切到"已经是结果"的那张图，和产物对得上
        draft: result.run
          ? { ...docFromRun(result.run), plan: s.draft.plan, ts: Date.now() }
          : s.draft,
      }));
      get().armIdleStop();
    } catch (e) {
      if (msgId) endTurn(msgId, { reply: `执行失败：${e}`, error: String(e) });
      set((s) => ({
        busy: false,
        runNodes: {},
        runNow: null,
        stage: "",
        error: String(e),
        messages: msgId
          ? s.messages
          : [
              ...s.messages,
              {
                id: uid(),
                role: "assistant",
                content: `执行失败：${e}`,
                ts: Date.now(),
                kind: "error",
              },
            ],
      }));
    }
  },

  addLearning: async (lesson) => {
    const trimmed = lesson.trim().slice(0, 200);
    if (!trimmed) return;
    const { config } = get();
    const cur = config?.memory?.learnings ?? [];
    if (cur.includes(trimmed)) return;
    get().addLog("info", `经验已沉淀：${trimmed}`);
    await get().saveConfig({ memory: { learnings: [trimmed, ...cur].slice(0, 30) } } as any);
  },

  clearLearnings: async () => {
    await get().saveConfig({ memory: { learnings: [] } } as any);
    get().addLog("info", "经验记忆已清空");
  },

  removeLearning: async (index) => {
    const { config } = get();
    const cur = config?.memory?.learnings ?? [];
    if (index < 0 || index >= cur.length) return;
    const next = cur.filter((_, i) => i !== index);
    await get().saveConfig({ memory: { learnings: next } } as any);
    get().addLog("info", `已删除经验：${cur[index].slice(0, 40)}`);
  },

  assembleShots: async (runId) => {
    if (get().busy) return;
    const run = get().runs.find((r) => r.id === runId);
    if (!run?.plan) return;
    const isVideo = (a: { kind?: string; url: string }) =>
      a.kind === "video" || /\.(mp4|webm|mov|mkv)(?:[?&#]|$)/i.test(a.url);
    // 按出片顺序拼：拖动过顺序的版本，成片也得跟着这个顺序
    const order =
      run.editOrder && run.editOrder.length === run.plan.shots.length
        ? run.editOrder
        : run.plan.shots.map((_, i) => i);
    const byShot = order
      .map((idx) => {
        const n = idx + 1;
        return run.assets.find(
          (a) => isVideo(a) && (a.nodeId === `shot_${n}_save_video` ||
            new RegExp(`shot0?${n}_video`, "i").test(a.filename))
        );
      })
      .filter(Boolean) as typeof run.assets;
    const files = (byShot.length ? byShot : run.assets.filter((a) => isVideo(a))).map((a) => ({
      filename: a.filename,
      subfolder: a.subfolder ?? "",
    }));
    if (!files.length) {
      set({ error: "这个计划还没有视频产出，先开拍或重跑出视频" });
      return;
    }
    set({ busy: true, runNodes: {}, runNow: null, stage: "合成成片", error: null });
    try {
      const res = await api.assembleShots(runId, files, run.plan.title);
      const asset: Asset = {
        filename: res.filename,
        subfolder: res.subfolder,
        type: "output",
        // 真身走 mediaSrc 的本地文件协议，这里只是兼容占位
        url: `kernel://view?filename=${encodeURIComponent(res.filename)}&subfolder=${encodeURIComponent(res.subfolder)}`,
        kind: "video",
        duration: res.duration ?? undefined,
      };
      const secs = res.duration ? `${res.duration.toFixed(1)}s · ` : "";
      set((s) => ({
        runs: s.runs.map((r) =>
          r.id === runId ? { ...r, assets: [...r.assets, asset] } : r
        ),
        busy: false,
        runNodes: {},
        runNow: null,
        stage: "",
        messages: [
          ...s.messages,
          {
            id: uid(),
            role: "assistant",
            content: `成片已合成：${secs}${res.filename}（在分镜板和资产页可直接播放）`,
            ts: Date.now(),
          },
        ],
      }));
      get().addLog("info", `成片已合成：${res.filename}`);
      get().armIdleStop();
    } catch (e) {
      set((s) => ({
        busy: false,
        runNodes: {},
        runNow: null,
        stage: "",
        error: String(e),
        messages: [
          ...s.messages,
          {
            id: uid(),
            role: "assistant",
            content: `合成失败：${e}`,
            ts: Date.now(),
            kind: "error",
          },
        ],
      }));
    }
  },

  deleteRun: (runId) => {
    set((s) => ({ runs: s.runs.filter((r) => r.id !== runId) }));
  },

  openOutputDir: async () => {
    const { env } = get();
    if (!env?.projectRoot || !env?.comfyBase) {
      set({ error: "环境信息还没有就绪" });
      return;
    }
    const dir = `${env.projectRoot}\${env.comfyBase}\output`;
    try {
      await api.openInExplorer(dir);
    } catch (e) {
      get().addLog("error", `打开目录失败：${e}`);
    }
  },

  rerunGraph: async (runId, graph) => {
    if (get().busy) return;
    const source = get().runs.find((r) => r.id === runId);
    if (!source) return;
    set({ busy: true, runNodes: {}, runNow: null, stage: "校验修改后的图", error: null });

    const ok = await get().ensureComfy();
    if (!ok) {
      set((s) => ({
        busy: false,
        runNodes: {},
        runNow: null,
        stage: "",
        error: "内核未就绪，改动已保留在画布上",
        pendingGraph: { runId, graph },
      }));
      return;
    }
    const { config } = get();
    const c = client(config, get().comfy);
    const turnId = beginTurn();
    const h = makeHandlers(turnId);
    await get().runAndAnnounce(
      executeEditedGraph(graph, c, {
        onLog: (level, msg) => get().addLog(level, msg),
        onStage: (stage) => set({ stage }),
        onDelta: h.onDelta,
        onStep: h.onStep,
        onNode: h.onNode,
      }).then((result) => {
        // 人工改动回注对话：保留原计划的分镜结构，标注参数已被人改过
        if (result.run && source.plan) {
          result.run = { ...result.run, plan: source.plan };
        }
        return result;
      }),
      turnId
    );
  },

  rerunShot: async (runId, shotIndex) => {
    if (get().busy) return;
    const run = get().runs.find((r) => r.id === runId);
    const shot = run?.plan?.shots[shotIndex];
    if (!run?.plan || !shot) return;

    const subPlan: DramaPlan = {
      ...run.plan,
      shots: [shot],
      title: `${run.plan.title}（重跑 ${shotIndex + 1}）`,
    };
    set({ busy: true, runNodes: {}, runNow: null, stage: "准备重跑", error: null });

    // 画布同步：重跑不是黑箱。先把子计划编译成图放到画布上，
    // 执行进度（定妆/首帧/视频）才有处点亮，人也能看见完整工作流。
    {
      const { config: cfg } = get();
      const previewGraph = compilePlan(subPlan, {
        imageModel: cfg?.image?.model || "doubao-seedream-5-0-pro-260628",
        imageSize: cfg?.image?.size || "1080x1920",
        videoModel: cfg?.video?.model || "doubao-seedance-2-5-260628",
        videoResolution: cfg?.video?.resolution || "720p",
        generateAudio: cfg?.video?.generateAudio !== false,
        withVideo: !!cfg?.ark?.apiKey && subPlan.mode === "video",
        continuity: true,
      });
      set({
        draft: {
          id: run.id,
          graph: previewGraph,
          plan: subPlan,
          title: `重跑 ${shotIndex + 1} · ${run.plan.title}`,
          status: "running",
          note: `重跑自 ${run.id}`,
          fromAI: false,
          ts: Date.now(),
        },
      });
    }

    try {
      const ok = await get().ensureComfy();
      if (!ok) {
        set({ busy: false, runNodes: {}, runNow: null, stage: "", error: "内核未就绪，请检查环境后重试" });
        return;
      }
      const { config } = get();
      const c = client(config, get().comfy);
      const turnId = beginTurn();
      const h = makeHandlers(turnId);
      const result = await executePlanWithRepair(
        subPlan,
        c,
        {
          onLog: (level, msg) => get().addLog(level, msg),
          onStage: (stage) => set({ stage }),
          onDelta: h.onDelta,
          onStep: h.onStep,
          onNode: h.onNode,
        },
        {
          hasArkKey: !!config?.ark?.apiKey,
          hasModelKey: !!config?.llm?.apiKey,
          imageModel: config?.image?.model,
          imageSize: config?.image?.size,
          videoModel: config?.video?.model,
          videoResolution: config?.video?.resolution,
          generateAudio: config?.video?.generateAudio !== false,
          budget: config?.budget,
          label: `重跑镜头 ${shotIndex + 1}`,
          note: `重跑自 ${run.id}`,
          repairOnFailure: true,
          lessons: config?.memory?.learnings ?? [],
          onLesson: (lesson) => void get().addLearning(lesson),
        }
      );

      // 原地替换：单镜重跑的新产物直接盖回原版本那一镜，不再另开一条只有一镜的记录
      // （取消后不算数：断线可能被上游当成"完成"，不能把半截结果盖进去）
      if (result.run && !get().cancelRequested) {
        const fresh = remapShotAssets(result.run.assets, shotIndex);
        const shotGraph = remapShotGraph(result.run.graph ?? {}, shotIndex);
        set((s) => ({
          runs: s.runs.map((r) =>
            r.id === runId
              ? {
                  ...r,
                  assets: mergeShotAssets(r.assets, fresh, shotIndex),
                  shotCost: mergeShotCost(r.shotCost, result.run!.shotCost?.["1"], shotIndex),
                  graph: mergeShotGraph(r.graph, shotGraph, shotIndex),
                }
              : r
          ),
        }));
      }

      // 画布同步收尾：切回这一版的完整工作流（重跑节点已按镜号并进 run.graph）
      const updatedRun = get().runs.find((r) => r.id === runId);
      if (result.run && updatedRun && !get().cancelRequested) {
        set({ draft: { ...docFromRun(updatedRun), ts: Date.now() } });
      } else if (!result.run) {
        set((s) => ({ draft: { ...s.draft, status: result.error ? "error" : "done" } }));
      }

      endTurn(turnId, {
        reply: result.run
          ? `${result.reply}\n\n新结果已经替换到原版本的「${shotIndex + 1}」号镜上，没有另开一版。`
          : result.reply,
        error: result.error,
        degraded: result.degraded,
        graph: result.graph,
      });
      set((s) => ({
        busy: false,
        runNodes: {},
        runNow: null,
        stage: "",
        cancelRequested: false,
        tab: result.run ? "shots" : s.tab,
        error: result.error || null,
      }));
    } catch (e) {
      const stopped = get().cancelRequested;
      set((s) => ({
        busy: false,
        runNodes: {},
        runNow: null,
        stage: "",
        cancelRequested: false,
        error: stopped ? null : String(e),
        draft: stopped
          ? { ...s.draft, status: "draft" }
          : { ...s.draft, status: "error" },
      }));
      if (stopped) {
        endTurn(beginTurn(), { reply: "重跑取消了，画布保持原样。" });
      } else {
        const msg = humanError(String(e));
        endTurn(beginTurn(), { reply: `重跑失败：${msg}`, error: msg });
      }
    }
  },

  moveShot: (runId, from, to) =>
    set((s) => ({
      runs: s.runs.map((r) => {
        if (r.id !== runId || !r.plan) return r;
        const n = r.plan.shots.length;
        if (from === to || from < 0 || to < 0 || from >= n || to >= n) return r;
        const base =
          r.editOrder && r.editOrder.length === n
            ? [...r.editOrder]
            : Array.from({ length: n }, (_, i) => i);
        const [moved] = base.splice(from, 1);
        base.splice(to, 0, moved);
        return { ...r, editOrder: base };
      }),
    })),

  resetShotOrder: (runId) =>
    set((s) => ({
      runs: s.runs.map((r) => (r.id === runId ? { ...r, editOrder: undefined } : r)),
    })),

  saveConfig: async (patch) => {
    try {
      const old = get().config;
      const config = await api.setConfig(patch);
      const env = await api.envCheck();
      set({ config, env });
      get().addLog("info", "配置已保存");
      const arkChanged =
        !!patch.ark && !!old && old.ark?.apiKey !== config.ark?.apiKey;
      if (arkChanged) {
        // 内核每次提交都现读配置，Key 改完下次生成立刻生效，无需重启任何东西
        get().addLog("info", "ARK Key 已更新，下次生成即生效");
      }
    } catch (e) {
      get().addLog("error", `保存失败：${e}`);
    }
  },
  switchSession: (id) => {
    const s = get();
    if (id === s.activeId || s.busy) return;
    const target = s.sessions.find((x) => x.id === id);
    if (!target) return;
    set({
      sessions: s.sessions.map((x) =>
        x.id === s.activeId
          ? { ...x, messages: s.messages, runs: s.runs, lastPrompt: s.lastPrompt }
          : x
      ),
      activeId: id,
      messages: target.messages,
      runs: target.runs,
      lastPrompt: target.lastPrompt ?? null,      stage: "",
    });
  },

  newSession: () => {
    const s = get();
    if (s.busy) return;
    const fresh = freshSession();
    set({
      sessions: [
        ...s.sessions.map((x) =>
          x.id === s.activeId
            ? { ...x, messages: s.messages, runs: s.runs, lastPrompt: s.lastPrompt }
            : x
        ),
        fresh,
      ].slice(-30),
      activeId: fresh.id,
      messages: fresh.messages,
      runs: [],
      lastPrompt: null,
      tab: "graph",
    });
  },

  deleteSession: (id) => {
    const s = get();
    if (s.busy) return;
    const sessions = s.sessions.filter((x) => x.id !== id);
    if (!sessions.length) {
      const fresh = freshSession();
      set({
        sessions: [fresh],
        activeId: fresh.id,
        messages: fresh.messages,
        runs: [],
        lastPrompt: null,      });
      return;
    }
    if (id === s.activeId) {
      const next = sessions[sessions.length - 1];
      set({
        sessions,
        activeId: next.id,
        messages: next.messages,
        runs: next.runs,
        lastPrompt: next.lastPrompt ?? null,      });
      return;
    }
    set({ sessions });
  },


  /* ---------------- 项目（工程文件夹） ---------------- */

  refreshProjects: async () => {
    try {
      const projects = await api.projectList();
      set({ projects });
    } catch (e) {
      get().addLog("warn", `项目列表读取失败：${e}`);
    }
  },

  openProject: async (id) => {
    if (get().busy) {
      get().addLog("warn", "正在生成，等这轮结束再切项目");
      return;
    }
    try {
      const text = await api.projectLoad(id);
      const data = JSON.parse(text);
      const port = get().config?.comfyPort ?? 8188;
      const loaded = sanitizeLoaded(data, port);
      const meta = get().projects.find((x) => x.id === id);
      // 画布残留的 running 是上次没跑完的假状态，读进来时收掉
      const draft = loaded
        ? {
            ...loaded.draft,
            status: loaded.draft.status === "running" ? ("draft" as const) : loaded.draft.status,
            fromAI: false,
            change: undefined,
            rebuild: undefined,
            changedAt: undefined,
          }
        : starterDoc();
      set({
        project:
          meta ??
          ({ id, name: data.name || id, path: "", updatedAt: Date.now() } as ProjectMeta),
        sessions: loaded?.sessions ?? [],
        activeId: loaded?.activeId ?? "",
        messages: (loaded?.sessions ?? []).find((x) => x.id === loaded?.activeId)?.messages ?? [],
        runs: (loaded?.sessions ?? []).find((x) => x.id === loaded?.activeId)?.runs ?? [],
        lastPrompt: (loaded?.sessions ?? []).find((x) => x.id === loaded?.activeId)?.lastPrompt ?? null,
        expandedIds: loaded?.expanded ?? seedExpandedFromLocal(),
        draft,
        tab: "graph",
        error: null,
      });
      // 会话可能为空：补一条新会话，别让界面没有落点
      if (!get().sessions.length) {
        const fresh = freshSession();
        set({ sessions: [fresh], activeId: fresh.id, messages: fresh.messages, runs: [] });
      }
      if (!get().activeId || !get().sessions.some((x) => x.id === get().activeId)) {
        const last = get().sessions[get().sessions.length - 1];
        set({ activeId: last.id, messages: last.messages, runs: last.runs, lastPrompt: last.lastPrompt ?? null });
      }
      localStorage.setItem(PROJECT_POINTER_KEY, id);
      get().addLog("info", `已打开项目「${get().project?.name ?? id}」`);
      saveProjectSoon(get());
    } catch (e) {
      get().addLog("error", `打开项目失败：${e}`);
    }
  },

  createProject: async (name) => {
    if (get().busy) return;
    try {
      // 先把当前打开的项目收尾保存，再切到新项目
      const cur = get();
      if (cur.project) {
        const json = snapshotOf(cur);
        if (json) await api.projectSave(cur.project.id, json).catch(() => {});
      }
      const meta = await api.projectCreate(name);
      const fresh = freshSession();
      set({
        projects: [meta, ...get().projects],
        project: meta,
        sessions: [fresh],
        activeId: fresh.id,
        messages: fresh.messages,
        runs: [],
        lastPrompt: null,
        expandedIds: [],
        draft: starterDoc(),
        tab: "graph",
        error: null,
      });
      localStorage.setItem(PROJECT_POINTER_KEY, meta.id);
      get().addLog("info", `已创建项目「${meta.name}」`);
      saveProjectSoon(get());
    } catch (e) {
      get().addLog("error", `创建项目失败：${e}`);
    }
  },

  deleteProject: async (id) => {
    if (get().busy) return;
    try {
      await api.projectDelete(id);
      get().addLog("info", `项目已删除：${id}`);
      const rest = get().projects.filter((x) => x.id !== id);
      set({ projects: rest });
      if (get().project?.id === id) {
        if (rest.length) {
          await get().openProject(rest[0].id);
        } else {
          // 全删光了：落回一个空白会话，项目置空（界面还能用，改动暂存内存）
          const fresh = freshSession();
          set({
            project: null,
            sessions: [fresh],
            activeId: fresh.id,
            messages: fresh.messages,
            runs: [],
            lastPrompt: null,
            expandedIds: [],
            draft: starterDoc(),
          });
          localStorage.removeItem(PROJECT_POINTER_KEY);
        }
      }
    } catch (e) {
      get().addLog("error", `删除项目失败：${e}`);
    }
  },

  renameProject: async (id, name) => {
    try {
      const meta = await api.projectRename(id, name);
      set((s) => ({
        projects: s.projects.map((x) => (x.id === id ? meta : x)),
        project: s.project?.id === id ? meta : s.project,
      }));
      // 名字写进 project.json
      saveProjectSoon(get());
    } catch (e) {
      get().addLog("error", `重命名失败：${e}`);
    }
  },

  openProjectFolder: async () => {
    const p = get().project;
    if (!p?.path) return;
    try {
      await api.openInExplorer(p.path);
    } catch (e) {
      get().addLog("warn", `打开文件夹失败：${e}`);
    }
  },

  setProjectsRoot: async (path) => {
    if (get().busy) return;
    try {
      // 先把当前项目收尾保存到旧根，再换根
      const cur = get();
      if (cur.project) {
        const json = snapshotOf(cur);
        if (json) await api.projectSave(cur.project.id, json).catch(() => {});
      }
      await api.projectSetRoot(path);
      await get().refreshProjects();
      // 新根下有同名项目就接着用；没有就留在内存态，提示用户
      const again = get().projects.find((x) => x.id === cur.project?.id);
      if (again) {
        await get().openProject(again.id);
      } else {
        get().addLog("info", "项目根目录已切换（当前项目不在新目录里，改动仍在内存中，切项目前记得新建同名项目）");
      }
    } catch (e) {
      get().addLog("error", `切换项目根目录失败：${e}`);
    }
  },

  exportRunAssets: async (runId) => {
    const s = get();
    if (s.busy || !s.project) return;
    const run = s.runs.find((r) => r.id === runId);
    if (!run) return;
    if (!s.outDir) {
      set({ error: "输出目录还没就绪，稍后再试" });
      return;
    }
    const isVideo = (a: Asset) =>
      a.kind === "video" || /\.(mp4|webm|mov|mkv)(?:[?&#]|$)/i.test(a.filename || "");
    // 有成片导成片；没有就按镜号把分镜视频全带回去
    const film = run.assets.find((a) => (a.subfolder || "").includes("film") && isVideo(a));
    const picks = film
      ? [film]
      : (run.plan?.shots ?? [])
          .map((_, i) => i + 1)
          .map((n) =>
            run.assets.find(
              (a) =>
                isVideo(a) &&
                (a.nodeId === `shot_${n}_save_video` ||
                  new RegExp(`shot0?${n}_video`, "i").test(a.filename || ""))
            )
          )
          .filter(Boolean) as Asset[];
    if (!picks.length) {
      set({ error: "这条记录还没有视频可导出" });
      return;
    }
    const paths = picks.map((a) => joinPath(s.outDir!, a.subfolder, a.filename ?? ""));
    try {
      const dests = await api.projectExportFiles(s.project.id, paths);
      const label = film ? "成片" : `${picks.length} 个分镜视频`;
      get().addLog("info", `已导出${label}到项目 export/：${dests.join(" ｜ ")}`);
    } catch (e) {
      get().addLog("error", `导出失败：${e}`);
    }
  },

  exportStoryboard: async (runId) => {
    const s = get();
    if (s.busy) return;
    const run = s.runs.find((r) => r.id === runId);
    if (!run?.plan) return;
    if (!s.project) {
      set({ error: "还没打开项目，分镜表没有地方落" });
      return;
    }
    try {
      const csv = storyboardCsv(run.plan, run.editOrder);
      const safe = run.plan.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || run.id;
      const path = await api.projectWriteExport(s.project.id, `分镜表-${safe}.csv`, csv);
      get().addLog("info", `分镜表已导出到项目 export/：${path}`);
    } catch (e) {
      get().addLog("error", `分镜表导出失败：${e}`);
    }
  },

  cleanupTestOutputs: async () => {
    if (get().busy) return;
    try {
      const files = await api.comfyOutputList();
      // 冒烟测试用的 demo_/test_/final_check_/scratch_ 这类前缀才进候选；
      // 正式产物（storyforge/shotNN_*、storyforge/film/ 成片）的 stem 不匹配白名单，
      // 再加上"被任何执行记录引用过就跳过"双保险，跨工程的真实产物不会被误伤。
      const TEST_RE = /^(demo|test|progress_test|final_check|scratch|progress|concat_test)[_\-]?\d*/i;
      const referenced = new Set(
        get()
          .sessions.flatMap((x) => x.runs)
          .flatMap((r) => r.assets.map((a) => `${(a.subfolder || "").replace(/\\/g, "/")}/${a.filename ?? ""}`))
      );
      const cands = files.filter((f) => {
        const path = `${(f.subfolder || "").replace(/\\/g, "/")}/${f.filename}`;
        if (path.startsWith("_trash/") || path.startsWith("storyforge/film/")) return false;
        const stem = f.filename.replace(/\.[^.]+$/, "");
        return TEST_RE.test(stem) && !referenced.has(path);
      });
      if (!cands.length) {
        get().addLog("info", "没有可清理的测试产物，输出目录很干净。");
        return;
      }
      const mb = cands.reduce((n, f) => n + f.bytes, 0) / 1024 / 1024;
      const ok = window.confirm(
        `发现 ${cands.length} 个没被任何执行记录引用的测试产物（共 ${mb.toFixed(1)} MB）。\n` +
          "它们会被移进 output/_trash/（不真删，随时可捞回）。\n\n" +
          cands
            .slice(0, 8)
            .map((f) => `· ${f.subfolder ? f.subfolder + "/" : ""}${f.filename}`)
            .join("\n") +
          (cands.length > 8 ? `\n…等 ${cands.length} 个` : "") +
          "\n\n确定清理吗？"
      );
      if (!ok) return;
      const r = await api.comfyOutputTrash(cands);
      get().addLog(
        "info",
        `已把 ${r.moved} 个测试产物（${(r.bytes / 1024 / 1024).toFixed(1)} MB）移进 output/_trash/。`
      );
    } catch (e) {
      get().addLog("error", `清理测试产物失败：${e}`);
    }
  },
  };
});

// 会话镜像与持久化：messages/runs 变化写回当前会话，并存 localStorage
let mirroring = false;
useStore.subscribe((s, prev) => {
  if (
    s.messages === prev.messages &&
    s.runs === prev.runs &&
    s.lastPrompt === prev.lastPrompt &&
    s.draft === prev.draft
  )
    return;
  if (mirroring) return;
  mirroring = true;
  try {
    useStore.setState((st) => ({
      sessions: st.sessions.map((x) =>
        x.id === st.activeId
          ? { ...x, messages: st.messages, runs: st.runs, lastPrompt: st.lastPrompt }
          : x
      ),
    }));
  } finally {
    mirroring = false;
  }
  const st = useStore.getState();
  if (st.project) {
    // 项目模式：整个工作区落盘到 project.json（防抖）
    saveProjectSoon(st);
  } else {
    // 还没进项目时代：维持旧的 localStorage 持久化
    persistSessions(st);
  }
});
