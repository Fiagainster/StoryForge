export type Role = "user" | "assistant" | "system";

/** 一轮回复里的一步：思考 / 工具调用 / 模型原始输出 */
export interface ChatStep {
  id: string;
  kind: "think" | "tool" | "output";
  title: string;
  /** 展开后看到的细节（原始输出、错误、操作清单） */
  detail?: string;
  /** 右侧一句话结果，如「3 镜 · 21s」「1204 tokens · 6.2s」 */
  note?: string;
  status: "running" | "done" | "error";
  startedAt: number;
  endedAt?: number;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  ts: number;
  kind?: "text" | "plan" | "run" | "error";
  meta?: Record<string, unknown>;
  /** 过程步骤（思考、工具调用），按顺序展示 */
  steps?: ChatStep[];
  /** 思考正文（reasoning_content），流式增长 */
  thinking?: string;
  /** 正在流式输出 */
  streaming?: boolean;
}

export interface EnvReport {
  configPath: string;
  projectRoot: string;
  /** 工作区目录（原 ComfyUI base，产物仍在它的 output/ 下） */
  comfyDir: string;
  comfyBase: string;
  comfyDirExists: boolean;
  comfyBaseExists: boolean;
  /** 提示词资产（engine/prompts）是否就绪 */
  nodesInstalled: boolean;
  /** ffmpeg + ffprobe 是否可用（拼接成片 / 尾帧接续 / 占位图） */
  ffmpegReady: boolean;
  llmKeySet: boolean;
  arkKeySet: boolean;
  llmModel: string;
  llmBaseUrl: string;
  /** 兼容保留：内核时代无端口概念，恒为 0 */
  comfyPort: number;
}

export interface ComfyStatus {
  running: boolean;
  port: number;
  stats?: unknown;
}

export interface Asset {
  filename: string;
  subfolder?: string;
  type?: string;
  url: string;
  /** 产出该文件的 ComfyUI 节点 ID，用于把素材对应回镜头 */
  nodeId?: string;
  kind?: "image" | "video" | "audio";
  /** 视频 / 音频时长（秒），来自 ComfyUI 产物 metadata */
  duration?: number;
}

/** 一次执行的资源用量：LLM token 来自出计划那轮，图/视频来自执行产物 */
export interface RunUsage {
  llmTokens: number;
  images: number;
  videoSeconds: number;
}

export type ShotSize =
  | "大远景"
  | "远景"
  | "全景"
  | "中景"
  | "中近景"
  | "近景"
  | "特写"
  | "大特写";

export type CameraMove =
  | "固定"
  | "缓慢推近"
  | "缓慢拉远"
  | "横移"
  | "跟拍"
  | "手持"
  | "环绕"
  | "俯拍"
  | "仰拍";

export interface DramaCharacter {
  id: string;
  name: string;
  /** 逐字复用的外貌/服装/气质锚点 */
  anchor: string;
}

export interface DramaShot {
  title: string;
  characters: string[];
  location: string;
  action: string;
  emotion?: string;
  dialogue?: string;
  shotSize: ShotSize;
  camera: CameraMove;
  duration: number;
  generateAudio?: boolean;
}

export interface DramaPlan {
  title: string;
  mode: "image" | "video";
  style: string;
  characters: DramaCharacter[];
  shots: DramaShot[];
}

/** 一镜的实耗拆解：等多久、跑多久、重了几次 */
export interface ShotCost {
  /** 从上一镜跑完（或提交执行）到这一镜第一个节点开跑：在队列里干等的时间 */
  wait: number;
  /** 这一镜自己的节点在跑的墙钟总时长 */
  busy: number;
  /** 同一镜的节点被重复执行了几次（重跑 / 重试），0 表示一次过 */
  retries: number;
}

export interface RunRecord {
  id: string;
  promptId: string;
  graph: ComfyGraph;
  status: "queued" | "running" | "done" | "error";
  assets: Asset[];
  plan?: DramaPlan;
  usage?: RunUsage;
  /** 逐镜实耗（毫秒）：key 是镜号，来自 /ws 事件里每镜那组节点的起止 */
  shotCost?: Record<string, ShotCost>;
  /**
   * 出片顺序：一组成员是"原始镜序号"（0 基）。没这个字段就是自然顺序。
   * 只影响展示与合成成片，不动产物文件、不需要重新生成。
   */
  editOrder?: number[];
  error?: string;
  startedAt: number;
  finishedAt?: number;
  note?: string;
}

export type ComfyGraph = Record<
  string,
  { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }
>;

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  text: string;
}

/** 一个对话会话：独立的消息流、执行历史与提示词 */
export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  runs: RunRecord[];
  lastPrompt?: string | null;
}

export interface AppConfig {
  projectRoot: string;
  comfyDir: string;
  comfyBase: string;
  venvPython: string;
  comfyPort: number;
  llm: { baseUrl: string; apiKey: string; model: string };
  ark: { apiKey: string };
  image: { model: string; size?: string };
  video: { model: string; resolution?: string; generateAudio?: boolean };
  /** 单次生成的预算上限：超出会被截断 */
  budget: { maxShots: number; maxSeconds: number };
  /** 自我完善：从失败修复中沉淀的经验，出计划时注入 */
  memory?: { learnings: string[] };
}


/** 一个项目（磁盘上的工程文件夹）的元信息 */
export interface ProjectMeta {
  id: string;
  name: string;
  path: string;
  updatedAt: number;
}

/** project.json 的内容：项目 = 画布 + 多条会话（会话里带执行记录） */
export interface ProjectData {
  schemaVersion: number;
  id: string;
  name: string;
  draft: unknown;
  sessions: unknown[];
  activeId: string;
  lastPrompt?: string | null;
  savedAt?: number;
}
