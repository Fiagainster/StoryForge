/**
 * 画布节点上的产物归位。
 *
 * 内核把每个节点跑完的东西按固定名字写在 `output/_run/{节点id}.png|mp4`，
 * 所以"这个节点做到哪一步了"只要看文件名就能还原——不用查执行历史，
 * 也不依赖引擎活着。这里只做纯映射，好单测。
 */

/** 某个节点在画布上能直接看到的产物 */
export interface NodeArtifact {
  filename: string;
  subfolder: string;
  kind: "image" | "video";
}

/** 磁盘上的一条文件记录（形状对齐内核 comfy_output_list） */
export interface RunFile {
  filename: string;
  subfolder?: string;
}

/** 画布现场副本所在的子目录 */
export const RUN_SUBDIR = "_run";

const MEDIA_EXT = /^(.+)\.(png|jpe?g|webp|mp4|webm)$/i;
const VIDEO_EXT = /^(mp4|webm)$/i;

/**
 * 把 `_run` 下的文件名翻回"节点 id → 产物"。
 * 同一个节点既留了图又留了视频时视频优先——视频是这条链走到最后的那一步。
 */
export function artifactsFromRunFiles(
  files: RunFile[],
  base: Record<string, NodeArtifact> = {}
): Record<string, NodeArtifact> {
  const next: Record<string, NodeArtifact> = { ...base };
  for (const f of files || []) {
    if ((f?.subfolder || "") !== RUN_SUBDIR) continue;
    const m = MEDIA_EXT.exec(f.filename || "");
    if (!m) continue;
    const kind: NodeArtifact["kind"] = VIDEO_EXT.test(m[2]) ? "video" : "image";
    const old = next[m[1]];
    if (old && old.kind === "video" && kind === "image") continue;
    next[m[1]] = { filename: f.filename, subfolder: RUN_SUBDIR, kind };
  }
  return next;
}

/**
 * 内核 `executed` 事件里带的那份产物坐标。
 * 字段不全就当没有——画布上少一张缩略图，不能因此把节点标成"有产物"。
 */
export function artifactFromEvent(
  file?: { filename?: string; subfolder?: string; kind?: string } | null
): NodeArtifact | null {
  if (!file || typeof file.filename !== "string" || !file.filename) return null;
  return {
    filename: file.filename,
    subfolder: file.subfolder || RUN_SUBDIR,
    kind: file.kind === "video" ? "video" : "image",
  };
}
