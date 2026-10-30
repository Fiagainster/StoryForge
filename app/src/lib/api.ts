import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppConfig, ComfyStatus, EnvReport, ProjectMeta } from "../types";

export const getConfig = () => invoke<AppConfig>("get_config");

export const setConfig = (patch: Partial<AppConfig>) =>
  invoke<AppConfig>("set_config", { patch });

export const envCheck = () => invoke<EnvReport>("env_check");

export const comfyStatus = () => invoke<ComfyStatus>("comfy_status");

export const comfyStart = () => invoke<Record<string, unknown>>("comfy_start");

export const comfyStop = () => invoke<Record<string, unknown>>("comfy_stop");

/** 产物在磁盘上的真实目录：引擎关掉后仍能直接读文件，不靠 /view */
export const comfyOutputDir = () => invoke<string>("comfy_output_dir");

export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface LlmReply {
  content: string | null;
  usage: LlmUsage | null;
}

export const llmChat = (
  messages: { role: string; content: string }[],
  model?: string,
  jsonMode?: boolean
) => invoke<LlmReply>("llm_chat", { messages, model, jsonMode });

export interface LlmStreamReply {
  content: string;
  reasoning: string;
  usage: LlmUsage | null;
  /** stop / length / …；length 说明额度烧完了，正文可能没输出 */
  finishReason?: string;
  /** 被「停止」掐断的：正文是半截的，不能当正常结果用 */
  cancelled?: boolean;
}

/** 当前正在跑的流：点「停止」时掐它 */
let activeStreamId: string | null = null;

export async function llmAbort(): Promise<void> {
  try {
    await invoke("llm_abort", { streamId: activeStreamId });
  } catch {
    /* 掐不动就算了，让它自己说完 */
  }
}

/** 流式对话：Rust 侧逐块 emit `llm://delta`，这里按 streamId 订阅 */
export async function llmChatStream(opts: {
  streamId: string;
  messages: { role: string; content: string }[];
  model?: string;
  jsonMode?: boolean;
  onDelta?: (kind: "content" | "reasoning", text: string) => void;
}): Promise<LlmStreamReply> {
  let un: UnlistenFn | null = null;
  if (opts.onDelta) {
    un = await listen<{ streamId: string; kind: "content" | "reasoning"; text: string }>(
      "llm://delta",
      (e) => {
        if (e.payload?.streamId !== opts.streamId) return;
        opts.onDelta?.(e.payload.kind, e.payload.text);
      }
    );
  }
  activeStreamId = opts.streamId;
  try {
    return await invoke<LlmStreamReply>("llm_chat_stream", {
      streamId: opts.streamId,
      messages: opts.messages,
      model: opts.model,
      jsonMode: opts.jsonMode,
    });
  } finally {
    un?.();
    if (activeStreamId === opts.streamId) activeStreamId = null;
  }
}

/** 设置页的「测试连接」：一次最小请求，验证 Key / Base URL / 模型名 */
export async function llmPing() {
  const t0 = Date.now();
  const r = await llmChat(
    [{ role: "user", content: "只回复两个字：可用" }],
    undefined,
    false
  );
  return {
    ms: Date.now() - t0,
    reply: (r?.content || "").trim().slice(0, 60),
    tokens: r?.usage?.total_tokens ?? 0,
  };
}

export const openInExplorer = (path: string) =>
  invoke<void>("open_in_explorer", { path });

export interface AssembleResult {
  ok: boolean;
  runId: string;
  filename: string;
  subfolder: string;
  duration?: number | null;
}

export const assembleShots = (runId: string, files: { filename: string; subfolder?: string }[], title: string) =>
  invoke<AssembleResult>("assemble_shots", { runId, files, title });

/* ---------------- 项目（工程文件夹） ---------------- */
export const projectRoot = () => invoke<string>("project_root");
export const projectSetRoot = (path: string) => invoke<string>("project_set_root", { path });
export const projectList = () => invoke<ProjectMeta[]>("project_list");
export const projectLoad = (id: string) => invoke<string>("project_load", { id });
export const projectSave = (id: string, json: string) => invoke<void>("project_save", { id, json });
export const projectCreate = (name: string) => invoke<ProjectMeta>("project_create", { name });
export const projectRename = (id: string, name: string) => invoke<ProjectMeta>("project_rename", { id, name });
export const projectDelete = (id: string) => invoke<void>("project_delete", { id });

export const projectExportFiles = (id: string, paths: string[]) =>
  invoke<string[]>("project_export_files", { id, paths });

/** 把一段文本（分镜表 CSV 等）写进项目的 export/ 文件夹，返回落点绝对路径 */
export const projectWriteExport = (id: string, filename: string, contents: string) =>
  invoke<string>("project_write_export", { id, filename, contents });
