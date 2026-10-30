import type { Asset, ComfyGraph, ShotCost } from "../types";

/**
 * 单镜重跑的原地替换：把子计划（只有一镜，产物都叫 shot_1_*）的产物
 * 盖回原 run 的第 shotIndex 镜。拆成纯函数，合并逻辑可以脱离引擎单测。
 */

/** 子计划的产物编号从 shot_1_* 改回真实镜号 shot_N_* */
export function remapShotAssets(assets: Asset[], shotIndex: number): Asset[] {
  const n = shotIndex + 1;
  return assets.map((a) => ({
    ...a,
    nodeId: a.nodeId?.replace(/^shot_1_/, `shot_${n}_`) ?? a.nodeId,
  }));
}

/** 判断一个产物是不是第 shotIndex 镜的旧产物（按 nodeId 为主、文件名兜底） */
export function isShotAsset(a: Asset, shotIndex: number): boolean {
  const n = shotIndex + 1;
  return (
    a.nodeId === `shot_${n}_save` ||
    a.nodeId === `shot_${n}_save_video` ||
    // 文件名兜底：shot01_frame / shot1_video（两位补零的 pad）
    new RegExp(`shot0?${n}_(frame|video)`, "i").test(a.filename ?? "")
  );
}

/** 旧产物剔除 + 新产物追加，返回新的 assets 数组（不改原数组） */
export function mergeShotAssets(oldAssets: Asset[], fresh: Asset[], shotIndex: number): Asset[] {
  return [...oldAssets.filter((a) => !isShotAsset(a, shotIndex)), ...fresh];
}

/** 逐镜成本原位更新：子计划里只有镜 1 的成本，盖回真实镜号 */
export function mergeShotCost(
  old: Record<string, ShotCost> | undefined,
  fresh: ShotCost | undefined,
  shotIndex: number
): Record<string, ShotCost> {
  const cost = { ...(old ?? {}) };
  if (fresh) cost[String(shotIndex + 1)] = fresh;
  return cost;
}

/** 子计划图 → 真实镜号：节点 id 和图内连线引用里的 shot_1_* 一起改 */
export function remapShotGraph(graph: ComfyGraph, shotIndex: number): ComfyGraph {
  const n = shotIndex + 1;
  const out: ComfyGraph = {};
  for (const [id, node] of Object.entries(graph)) {
    const newId = id.replace(/^shot_1_/, `shot_${n}_`);
    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string" && /^shot_1_/.test(v[0])) {
        inputs[k] = [`shot_${n}_${String(v[0]).slice(7)}`, v[1]];
      } else {
        inputs[k] = v;
      }
    }
    out[newId] = { ...node, inputs };
  }
  return out;
}

/** 重跑后的完整 run 图：旧图里有分镜节点就按镜号覆盖，没有（冒烟杂图）就整个换成这张 */
export function mergeShotGraph(
  runGraph: ComfyGraph | undefined,
  shotGraph: ComfyGraph,
  shotIndex: number
): ComfyGraph {
  const base = runGraph && Object.keys(runGraph).length ? { ...runGraph } : {};
  const hasShots = Object.keys(base).some((k) => /^shot_\d+_/.test(k));
  return hasShots ? { ...base, ...shotGraph } : shotGraph;
}
