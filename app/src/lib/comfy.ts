import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Asset, ComfyGraph } from "../types";

export interface HistoryEntry {
  outputs?: Record<string, Record<string, unknown>>;
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
  /** 内核执行失败的原因（对齐 ComfyUI 的 exception_message 位） */
  error?: string;
}

/** 执行进度事件：内核的 `kernel://event` 推什么，这里就翻成什么 */
export interface WatchEvent {
  kind: "start" | "node" | "progress" | "nodeDone" | "cached" | "done" | "error";
  node?: string;
  /** 缓存命中的一批节点 */
  nodes?: string[];
  /** 0–1 */
  pct?: number;
  detail?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 原生内核客户端。类名保留 ComfyClient：agent.ts / store.ts 的调用点一行不用改。
 *
 * 和旧 ComfyUI 客户端同构：
 *   queuePrompt  → kernel_submit_cmd（校验 + 后台执行，返回 prompt_id）
 *   watch        → 订阅 `kernel://event`，消息形状对齐 ComfyUI /ws
 *   history      → kernel_history，形状对齐 /history/{prompt_id}
 *   interrupt    → kernel_interrupt（comfy_stop 也走它）
 */
export class ComfyClient {
  constructor() {}

  async systemStats() {
    return { native: true };
  }

  async objectInfo(): Promise<Record<string, unknown>> {
    return {};
  }

  async queuePrompt(graph: ComfyGraph, clientId: string): Promise<string> {
    try {
      const data = await invoke<{ prompt_id: string }>("kernel_submit_cmd", {
        graph,
        clientId,
      });
      if (!data?.prompt_id) throw new Error("内核未返回 prompt_id");
      return data.prompt_id;
    } catch (e) {
      // 内核拒收（未知节点 / 断线 / 环）——错误文案在 Rust 侧已是人话
      throw new Error(`内核拒绝执行：${String(e)}`);
    }
  }

  async history(promptId: string): Promise<HistoryEntry | undefined> {
    try {
      const data = await invoke<Record<string, HistoryEntry>>("kernel_history", {
        promptId,
      });
      return data?.[promptId];
    } catch {
      return undefined;
    }
  }

  async interrupt() {
    await invoke("kernel_interrupt").catch(() => {});
  }

  /** 产物显示走 mediaSrc 的本地文件协议，这个 URL 只是兜底占位 */
  viewUrl(file: { filename: string; subfolder?: string }) {
    const q = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder || "",
    });
    return `kernel://view?${q.toString()}`;
  }

  collectAssets(outputs: Record<string, Record<string, unknown>> | undefined): Asset[] {
    const list: Asset[] = [];
    for (const [nodeId, out] of Object.entries(outputs || {})) {
      for (const [key, kind] of [
        ["images", "image"],
        ["gifs", "video"],
        ["videos", "video"],
        ["audio", "audio"],
        ["files", "image"],
      ] as const) {
        const arr = (out as any)?.[key];
        if (!Array.isArray(arr)) continue;
        for (const f of arr) {
          if (!f?.filename) continue;
          const meta = (f as any)?.metadata;
          list.push({
            filename: f.filename,
            subfolder: f.subfolder,
            type: f.type,
            url: this.viewUrl(f),
            nodeId,
            kind: meta?.kind === "video" || meta?.kind === "audio" ? meta.kind : kind,
            duration:
              typeof meta?.duration === "number" && meta.duration > 0
                ? meta.duration
                : undefined,
          });
        }
      }
    }
    return list;
  }

  /**
   * 订阅一次执行的实时进度。内核在 `kernel://event` 上按 clientId 广播，
   * 消息形状对齐 ComfyUI /ws：executing / progress / executed / execution_*。
   */
  watch(clientId: string, on: (e: WatchEvent) => void): () => void {
    let un: UnlistenFn | null = null;
    let closed = false;
    listen<{ clientId: string; promptId: string; msg: Record<string, unknown> }>(
      "kernel://event",
      (e) => {
        if (e.payload?.clientId !== clientId) return;
        handle(e.payload.msg || {});
      }
    )
      .then((u) => {
        if (closed) u();
        else un = u;
      })
      .catch(() => {});

    const handle = (m: Record<string, unknown>) => {
      switch (m.type) {
        case "execution_start":
          on({ kind: "start" });
          break;
        case "executing":
          if (m.node) on({ kind: "node", node: String(m.node) });
          break;
        case "progress":
          if (m.node) {
            on({
              kind: "progress",
              node: String(m.node),
              detail: typeof m.detail === "string" ? m.detail : undefined,
            });
          }
          break;
        case "executed":
          if (m.node) on({ kind: "nodeDone", node: String(m.node) });
          break;
        case "execution_success":
          on({ kind: "done" });
          break;
        case "execution_error":
          on({
            kind: "error",
            detail: String(m.message || "执行出错"),
          });
          break;
        default:
          break;
      }
    };
    return () => {
      closed = true;
      try {
        un?.();
      } catch {
        /* 关不掉就算了 */
      }
    };
  }

  async waitForPrompt(
    promptId: string,
    onTick?: (elapsedMs: number) => void,
    timeoutMs = 60 * 60 * 1000
  ): Promise<Asset[]> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const entry = await this.history(promptId);
      if (entry) {
        const st = entry.status?.status_str;
        if (st === "error") {
          throw new Error(entry.error || "执行失败");
        }
        const assets = this.collectAssets(entry.outputs);
        if (assets.length > 0) return assets;
        if (entry.status?.completed) return [];
      }
      onTick?.(Date.now() - started);
      await sleep(700);
    }
    throw new Error("执行超时（60 分钟）");
  }
}
