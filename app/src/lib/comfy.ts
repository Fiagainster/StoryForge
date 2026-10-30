import type { Asset, ComfyGraph } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface HistoryEntry {
  outputs?: Record<string, Record<string, unknown>>;
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
}

/** 执行进度事件：ComfyUI 的 /ws 推什么，这里就翻成什么 */
export interface WatchEvent {
  kind: "start" | "node" | "progress" | "nodeDone" | "cached" | "done" | "error";
  node?: string;
  /** 缓存命中的一批节点 */
  nodes?: string[];
  /** 0–1 */
  pct?: number;
  detail?: string;
}

export class ComfyClient {
  constructor(public base: string) {}

  async systemStats() {
    const r = await fetch(`${this.base}/system_stats`);
    if (!r.ok) throw new Error(`system_stats ${r.status}`);
    return r.json();
  }

  async objectInfo(): Promise<Record<string, unknown>> {
    const r = await fetch(`${this.base}/object_info`);
    if (!r.ok) throw new Error(`object_info ${r.status}`);
    return r.json();
  }

  async queuePrompt(graph: ComfyGraph, clientId: string): Promise<string> {
    const r = await fetch(`${this.base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
    });
    const text = await r.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`提交失败：${text.slice(0, 400)}`);
    }
    if (data?.error) {
      throw new Error(
        `ComfyUI 拒绝执行：${data.error.message || data.error.type || JSON.stringify(data.error)}`
      );
    }
    if (data?.node_errors && Object.keys(data.node_errors).length > 0) {
      const detail = Object.entries(data.node_errors)
        .map(([id, v]: [string, any]) => {
          const errs = (v?.errors || []).map((e: any) => e?.message).join("; ");
          return `节点 ${id}(${v?.class_type || "?"}): ${errs}`;
        })
        .join("\n");
      throw new Error(`节点校验失败：\n${detail}`);
    }
    if (!data?.prompt_id) throw new Error(`未返回 prompt_id：${text.slice(0, 300)}`);
    return data.prompt_id as string;
  }

  async history(promptId: string): Promise<HistoryEntry | undefined> {
    const r = await fetch(`${this.base}/history/${promptId}`);
    if (!r.ok) return undefined;
    const data = await r.json();
    return data?.[promptId];
  }

  async interrupt() {
    await fetch(`${this.base}/interrupt`, { method: "POST" }).catch(() => {});
  }

  viewUrl(file: { filename: string; subfolder?: string; type?: string }) {
    const q = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder || "",
      type: file.type || "output",
    });
    return `${this.base}/view?${q.toString()}`;
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
   * 订阅一次执行的实时进度。
   * 之前只能看 `/history` 轮询，生成那几分钟画布是死的；
   * /ws 会推 executing（开始跑哪个节点）、progress（跑了多少）、executed（哪个节点出结果），
   * 拿到就能在画布上把"现在跑到哪一步"点亮。
   */
  watch(clientId: string, on: (e: WatchEvent) => void): () => void {
    const wsUrl = `${this.base.replace(/^http/, "ws")}/ws?clientId=${encodeURIComponent(clientId)}`;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return () => {};
    }
    const handle = (raw: unknown) => {
      let m: any;
      try {
        m = JSON.parse(typeof raw === "string" ? raw : "");
      } catch {
        return;
      }
      const d = m?.data || {};
      switch (m?.type) {
        case "execution_start":
          on({ kind: "start" });
          break;
        case "executing":
          // data.node 为空 = 这一轮跑完了
          if (d.node) on({ kind: "node", node: String(d.node) });
          break;
        case "progress": {
          const max = Number(d.max) || 0;
          const value = Number(d.value) || 0;
          if (d.node) {
            on({
              kind: "progress",
              node: String(d.node),
              pct: max > 0 ? Math.min(1, Math.max(0, value / max)) : undefined,
            });
          }
          break;
        }
        case "executed":
          if (d.node) on({ kind: "nodeDone", node: String(d.node) });
          break;
        case "execution_cached":
          if (Array.isArray(d.nodes)) on({ kind: "cached", nodes: d.nodes.map(String) });
          break;
        case "execution_success":
          on({ kind: "done" });
          break;
        case "execution_error":
          on({
            kind: "error",
            node: d.node_id ? String(d.node_id) : undefined,
            detail: String(d.exception_message || "执行出错"),
          });
          break;
        default:
          break;
      }
    };
    ws.onmessage = (ev) => handle(ev.data);
    ws.onerror = () => {};
    return () => {
      try {
        ws?.close();
      } catch {
        /* 关不掉就算了 */
      }
    };
  }

  async waitForPrompt(
    promptId: string,
    onTick?: (elapsedMs: number) => void,
    timeoutMs = 60 * 60 * 1000
  ): Promise<Asset[]> {    const started = Date.now();
    let netErrors = 0;
    while (Date.now() - started < timeoutMs) {
      let entry: HistoryEntry | undefined;
      try {
        entry = await this.history(promptId);
        netErrors = 0;
      } catch {
        // ComfyUI 可能临时失联（重启/高负载）：连续失败才报错
        netErrors += 1;
        if (netErrors >= 10) {
          throw new Error("与 ComfyUI 失去连接（连续多次查询失败），请检查它是否还在运行");
        }
        await sleep(1500);
        continue;
      }
      if (entry) {
        const st = entry.status?.status_str;
        if (st === "error") {
          const msgs = JSON.stringify(entry.status?.messages || []).slice(0, 500);
          throw new Error(`执行失败：${msgs}`);
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
