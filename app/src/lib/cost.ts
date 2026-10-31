import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

/**
 * P0-2 成本估算：确认门显示"预计 ¥X（含重试缓冲至多 ¥Y）"。
 * 估算逻辑在 Rust 内核里（和 cap 拦截同一张价格表），这里只是薄薄一层 invoke + 缓存。
 */
export interface CostEstimate {
  low: number;
  high: number;
  currency: string;
}

const cache = new Map<string, CostEstimate>();

/** 图变了就重估（JSON 串做缓存键，同图不重复 invoke） */
export function useCostEstimate(graph: unknown): CostEstimate | null {
  const key = graph ? JSON.stringify(graph) : "";
  const [est, setEst] = useState<CostEstimate | null>(() =>
    key ? cache.get(key) ?? null : null
  );
  useEffect(() => {
    if (!key) {
      setEst(null);
      return;
    }
    const hit = cache.get(key);
    if (hit) {
      setEst(hit);
      return;
    }
    let alive = true;
    invoke<CostEstimate>("estimate_cost_cmd", { graph: JSON.parse(key) })
      .then((r) => {
        if (alive && r && typeof r.high === "number") {
          cache.set(key, r);
          setEst(r);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key]);
  return est;
}

export const fmtCny = (n: number) => `¥${n.toFixed(2)}`;
