import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore } from "./store";
import type { Asset } from "../types";

/**
 * 产物到底在哪儿。
 *
 * ComfyUI 的 /view 只在引擎活着的时候能取图；引擎一停（空闲自动停、手动停、退出）
 * 历史里的缩略图就全变成破图 —— 而文件其实一直躺在 output/ 里。
 * 所以拿到绝对路径后直接走本地文件协议，跟引擎死不死没关系。
 */
const joinPath = (dir: string, ...parts: (string | undefined)[]) => {
  const sep = dir.includes("\\") ? "\\" : "/";
  const tail = parts
    .filter((p): p is string => !!p)
    .map((p) => String(p).replace(/^[\\/]+|[\\/]+$/g, ""))
    .filter(Boolean);
  return [dir.replace(/[\\/]+$/, ""), ...tail].join(sep);
};

export function mediaSrc(
  a: Pick<Asset, "filename" | "subfolder" | "url"> | null | undefined,
  outDir?: string | null
): string {
  if (!a) return "";
  // 目录在 init 里拿一次，全局共用；显式传入的优先（便于测试）
  const dir = outDir === undefined ? useStore.getState().outDir : outDir;
  if (!dir || !a.filename) return a.url;
  try {
    return convertFileSrc(joinPath(dir, a.subfolder, a.filename));
  } catch {
    // 不在 Tauri 里跑（比如浏览器直开）：退回引擎的 /view
    return a.url;
  }
}
