import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { CanvasGraph } from "./CanvasGraph";
import { mediaSrc } from "../lib/media";
import type { Asset, DramaPlan, RunRecord, RunUsage } from "../types";
import type { NodeRun } from "../lib/store";
import { Btn, Empty, I, IconBtn, Spinner, Tag, cx } from "./ui";

const TABS = [
  { id: "graph", label: "画布" },
  { id: "shots", label: "分镜" },
  { id: "assets", label: "资产" },
  { id: "logs", label: "日志" },
] as const;

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (n: number) => n.toLocaleString("en-US");

/** 毫秒 → 「12.4s」；太短就写毫秒，别显示 0.0s */
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

/** 一次执行里所有镜头加起来花了多久（等 + 跑） */
const totalCost = (run: RunRecord) =>
  Object.values(run.shotCost ?? {}).reduce((a, c) => a + c.wait + c.busy, 0);

/** 元信息之间的小圆点分隔符，比一长串「·」干净 */
const Dot = () => <span className="text-[var(--line-3)]">·</span>;

const isVideo = (a: Pick<Asset, "kind" | "url">) =>
  a.kind === "video" || /\.(mp4|webm|mov|mkv)(?:[?&#]|$)/i.test(a.url);

const usageOf = (run: RunRecord): RunUsage =>
  run.usage ?? { llmTokens: 0, images: 0, videoSeconds: 0 };

function usageText(u: RunUsage) {
  const parts = [`${u.images} 图`];
  if (u.videoSeconds) parts.push(`${u.videoSeconds}s 视频`);
  if (u.llmTokens) parts.push(`LLM ${fmt(u.llmTokens)}`);
  return parts.join(" · ");
}

function shotFrame(run: RunRecord, n: number): Asset | undefined {
  const byNode = run.assets.find((a) => a.nodeId === `shot_${n}_save` && !isVideo(a));
  if (byNode) return byNode;
  return run.assets.find(
    (a) => new RegExp(`shot0?${n}_frame`, "i").test(a.filename) && !isVideo(a)
  );
}

function shotVideo(run: RunRecord, n: number): Asset | undefined {
  const byNode = run.assets.find((a) => a.nodeId === `shot_${n}_save_video`);
  if (byNode) return byNode;
  return run.assets.find(
    (a) => new RegExp(`shot0?${n}_video`, "i").test(a.filename) && isVideo(a)
  );
}

const filmOf = (run: RunRecord) =>
  run.assets.find((a) => isVideo(a) && (a.subfolder || "").includes("film"));

function characterName(plan: DramaPlan, id: string) {
  return plan.characters.find((c) => c.id === id)?.name || id;
}

/* ------------------------------------------------------------------ *
 * 分镜卡
 * ------------------------------------------------------------------ */

function ShotCard({
  run,
  shot,
  index,
  pos,
  onZoom,
  onRerun,
  busy,
}: {
  run: RunRecord;
  shot: DramaPlan["shots"][number];
  /** 原始镜序号（0 基）：产物是按这个号落盘的 */
  index: number;
  /** 在出片顺序里的位置（0 基）：卡片上显示的序号 */
  pos: number;
  onZoom: (a: Asset, list: Asset[]) => void;
  onRerun: (index: number) => void;
  busy: boolean;
}) {
  const n = index + 1;
  const frame = shotFrame(run, n);
  const video = shotVideo(run, n);
  const open = video || frame;
  const list = run.plan!.shots
    .map((_, i) => shotVideo(run, i + 1) || shotFrame(run, i + 1))
    .filter(Boolean) as Asset[];

  return (
    <div className="group overflow-hidden rounded-[12px] bg-[var(--bg-2)] shadow-[inset_0_0_0_0.5px_var(--line-1)] transition-shadow hover:shadow-[inset_0_0_0_0.5px_var(--line-3)]">
      <div
        className={cx("relative bg-[var(--bg-base)]", open && "cursor-zoom-in")}
        style={{ aspectRatio: "9 / 16" }}
        onClick={() => open && onZoom(open, list)}
      >
        {frame ? (
          <img
            src={mediaSrc(frame)}
            alt={shot.title}
            loading="lazy"
            className="absolute inset-0 size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.015]"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <span className="t-11 text-[var(--fg-4)]">未生成</span>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-2">
          <span className="t-11 tabular rounded-[5px] bg-black/55 px-1.5 py-px font-mono text-[var(--fg-2)] backdrop-blur-sm">
            {pad(pos + 1)}
          </span>
          {video ? <Tag tone="accent">视频</Tag> : null}
        </div>

        {video ? (
          <div className="absolute inset-0 grid place-items-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100">
            <span className="grid size-9 place-items-center rounded-full bg-black/55 pl-0.5 text-white shadow-lg backdrop-blur-sm">
              {I.play(13)}
            </span>
          </div>
        ) : null}

        {open ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/55 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
        ) : null}
      </div>

      <div className="px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1 truncate t-12 text-[var(--fg-1)]">{shot.title}</div>
          {pos !== index ? (
            <span
              className="shrink-0 t-11 tabular text-[var(--fg-4)]"
              title={`原本是第 ${pad(n)} 镜，产物也还是那一镜的`}
            >
              原{pad(n)}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="truncate t-11 text-[var(--fg-4)]">
            {shot.shotSize} · {shot.camera} · {shot.duration}s
            {run.shotCost?.[String(n)]
              ? ` · 实耗 ${fmtMs(run.shotCost[String(n)].busy)}`
              : ""}
            {shot.characters.length
              ? ` · ${shot.characters.map((id) => characterName(run.plan!, id)).join("/")}`
              : ""}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => onRerun(index)}
            disabled={busy}
            title="只重跑这一镜"
            className="shrink-0 t-11 text-[var(--fg-4)] opacity-0 transition-all hover:text-[var(--accent)] focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-30"
          >
            重跑
          </button>
        </div>
        {shot.dialogue ? (
          <div className="mt-1 truncate t-11 text-[var(--accent-dim)]">「{shot.dialogue}」</div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 生成中的分镜：画布在跑，这一页也要跟着亮
 * ------------------------------------------------------------------ */

/** 一镜的状态：节点 id 是 shot_N_* ，按前缀认领 */
function shotState(runNodes: Record<string, NodeRun>, n: number) {
  const prefix = `shot_${n}_`;
  const hits = Object.entries(runNodes || {}).filter(([id]) => id.startsWith(prefix));
  if (!hits.length) return { s: "idle" as const, pct: 0 };
  if (hits.some(([, v]) => v.s === "err")) return { s: "err" as const, pct: 0 };
  // 还在跑哪个节点，就显示那个的百分比
  const running = hits.find(([, v]) => v.s === "run");
  if (running) return { s: "run" as const, pct: running[1].pct ?? 0 };
  if (hits.every(([, v]) => v.s === "done" || v.s === "cache")) {
    return { s: "done" as const, pct: 1 };
  }
  return { s: "idle" as const, pct: 0 };
}

function LiveShotCard({
  shot,
  index,
  state,
  idleLabel,
}: {
  shot: DramaPlan["shots"][number];
  index: number;
  state: { s: "idle" | "run" | "done" | "err"; pct: number };
  idleLabel: string;
}) {
  const n = index + 1;
  const pct = Math.round(state.pct * 100);
  return (
    <div className="overflow-hidden rounded-[12px] bg-[var(--bg-2)] shadow-[inset_0_0_0_0.5px_var(--line-1)]">
      <div className="relative bg-[var(--bg-base)]" style={{ aspectRatio: "9 / 16" }}>
        <div className="absolute inset-0 grid place-items-center">
          {state.s === "run" ? (
            <div className="flex flex-col items-center gap-2">
              <Spinner className="size-4" />
              <span className="t-11 tabular text-[var(--accent)]">{pct}%</span>
            </div>
          ) : state.s === "done" ? (
            <span className="text-[var(--ok)]">{I.check(18)}</span>
          ) : state.s === "err" ? (
            <span className="t-11 text-[var(--err)]">出错</span>
          ) : (
            <span className="t-11 text-[var(--fg-4)]">{idleLabel}</span>
          )}
        </div>

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-2">
          <span className="t-11 tabular rounded-[5px] bg-black/55 px-1.5 py-px font-mono text-[var(--fg-2)] backdrop-blur-sm">
            {pad(n)}
          </span>
          {state.s === "run" ? <Tag tone="accent">生成中</Tag> : null}
          {state.s === "done" ? <Tag tone="quiet">完成</Tag> : null}
        </div>

        {state.s === "run" ? (
          <div className="absolute inset-x-2 bottom-2 h-[3px] overflow-hidden rounded-full bg-[var(--line-2)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
              style={{ width: `${Math.max(4, pct)}%` }}
            />
          </div>
        ) : null}
      </div>

      <div className="px-2.5 py-2">
        <div className="truncate t-12 text-[var(--fg-1)]">{shot.title}</div>
        <div className="mt-0.5 truncate t-11 text-[var(--fg-4)]">
          {shot.shotSize} · {shot.camera} · {shot.duration}s
        </div>
      </div>
    </div>
  );
}

/** 正在跑的这一版：分镜卡按节点进度亮起来 */
function LivePlan({
  plan,
  status,
  runNodes,
  busy,
  onRun,
  onStop,
}: {
  plan: DramaPlan;
  status: "draft" | "running" | "done" | "error";
  runNodes: Record<string, NodeRun>;
  busy: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  const states = plan.shots.map((_, i) => shotState(runNodes, i + 1));
  const done = states.filter((x) => x.s === "done").length;
  const errs = states.filter((x) => x.s === "err").length;
  const seconds = plan.shots.reduce((sum, s) => sum + s.duration, 0);
  const runningNow = states.findIndex((x) => x.s === "run");
  const live = status === "running";
  const idleLabel = live ? "排队中" : status === "error" ? "没跑完" : "还没生成";

  return (
    <section className="space-y-3 fade-in">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate t-16 font-medium text-[var(--fg-1)]">{plan.title}</h2>
            {live ? (
              <Tag tone="accent">生成中</Tag>
            ) : status === "error" ? (
              <Tag tone="err">上次失败</Tag>
            ) : (
              <Tag tone="quiet">待生成</Tag>
            )}
          </div>
          <div className="mt-0.5 t-11 tabular text-[var(--fg-4)]">
            {plan.shots.length} 镜 · 约 {seconds}s
            {live ? ` · 已完成 ${done}/${plan.shots.length}` : ""}
            {live && runningNow >= 0 ? ` · 正在跑第 ${runningNow + 1} 镜` : ""}
            {!live && errs ? ` · ${errs} 镜出错` : ""}
          </div>
        </div>

        {live ? (
          <Btn size="xs" variant="outline" onClick={onStop} title="停掉这一轮，画布不动">
            停止
          </Btn>
        ) : (
          <Btn
            size="xs"
            variant="primary"
            icon={I.play(10)}
            disabled={busy}
            onClick={onRun}
            title="按画布上现在这张图开跑"
          >
            {status === "error" ? "再试一次" : "开始生成"}
          </Btn>
        )}
      </div>

      {plan.style ? (
        <p className="max-w-[720px] border-l-[1.5px] border-[var(--line-3)] pl-2.5 t-12 leading-[19px] text-[var(--fg-3)]">
          {plan.style}
        </p>
      ) : null}

      <div className="grid content-start gap-3 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
        {plan.shots.map((shot, i) => (
          <LiveShotCard
            key={i}
            shot={shot}
            index={i}
            state={states[i]}
            idleLabel={idleLabel}
          />
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 一次执行
 * ------------------------------------------------------------------ */

function PlanRun({
  run,
  onZoom,
  onRerun,
  busy,
  onAssemble,
  onDelete,
  onOpenDir,
  onMove,
  onResetOrder,
  onExport,
  onStoryboard,
}: {
  run: RunRecord;
  onZoom: (a: Asset, list: Asset[]) => void;
  onRerun: (runId: string, index: number) => void;
  busy: boolean;
  onAssemble: (runId: string) => void;
  onDelete: (runId: string) => void;
  onOpenDir: () => void;
  onMove: (from: number, to: number) => void;
  onResetOrder: () => void;
  onExport: (runId: string) => void;
  onStoryboard: (runId: string) => void;
}) {
  const plan = run.plan!;
  const seconds = plan.shots.reduce((sum, s) => sum + s.duration, 0);
  const videos = plan.shots.filter((_, i) => !!shotVideo(run, i + 1)).length;
  const film = filmOf(run);
  const spent = totalCost(run);
  const waited = Object.values(run.shotCost ?? {}).reduce((a, c) => a + c.wait, 0);
  const busyTotal = Object.values(run.shotCost ?? {}).reduce((a, c) => a + c.busy, 0);
  const retried = Object.values(run.shotCost ?? {}).reduce((a, c) => a + c.retries, 0);
  /** 出片顺序：数组元素是原始镜序号；没拖过就是自然顺序 */
  const order =
    run.editOrder && run.editOrder.length === plan.shots.length
      ? run.editOrder
      : plan.shots.map((_, i) => i);
  const reordered = order.some((v, i) => v !== i);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);
  const endDrag = () => {
    setDragFrom(null);
    setDragTo(null);
  };

  return (
    <section className="space-y-4 border-t-[0.5px] border-[var(--line-1)] pt-6 first:border-0 first:pt-0">
      <div className="flex items-start gap-4 border-b-[0.5px] border-[var(--line-1)] pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate t-16 font-medium text-[var(--fg-1)]">{plan.title}</h2>
            <Tag tone={videos ? "accent" : "quiet"}>
              {videos ? `${videos}/${plan.shots.length} 镜成片` : "仅分镜图"}
            </Tag>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 t-11 tabular text-[var(--fg-4)]">
            <span>
              {plan.shots.length} 镜 · 计划 {seconds}s
              {spent ? ` · 生成 ${fmtMs(busyTotal)}` : ""}
              {waited >= 500 ? ` · 排队 ${fmtMs(waited)}` : ""}
              {retried ? ` · 重跑 ${retried} 次` : ""}
            </span>
            <Dot />
            <span>{usageText(usageOf(run))}</span>
            {plan.characters.length ? (
              <>
                <Dot />
                <span>{plan.characters.map((c) => c.name).join(" / ")}</span>
              </>
            ) : null}
            <Dot />
            <span className="font-mono">{run.id}</span>
            <span>
              {new Date(run.startedAt).toLocaleString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
          {reordered ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-[5px] bg-[var(--bg-2)] px-1.5 py-px t-11 tabular text-[var(--fg-2)]">
                出片顺序 {order.map((v) => pad(v + 1)).join(" → ")}
              </span>
              <button
                onClick={onResetOrder}
                className="t-11 text-[var(--fg-4)] transition-colors hover:text-[var(--fg-1)]"
              >
                恢复原序
              </button>
              <span className="t-11 text-[var(--fg-4)]">
                只改顺序，不重跑、不动文件；合成成片按这个顺序拼
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Btn
            size="xs"
            variant="outline"
            icon={I.film(11)}
            onClick={() => onAssemble(run.id)}
            disabled={busy || !videos}
            title="把这一版的镜头视频拼成一个成片"
          >
            合成成片
          </Btn>
          <Btn
            size="xs"
            variant="outline"
            icon={I.down(11)}
            onClick={() => onExport(run.id)}
            disabled={busy || (!videos && !film)}
            title={film ? "把成片拷进项目的 export/ 文件夹" : "把分镜视频拷进项目的 export/ 文件夹"}
          >
            导出
          </Btn>
          <Btn
            size="xs"
            variant="outline"
            icon={I.logs(11)}
            onClick={() => onStoryboard(run.id)}
            disabled={busy}
            title="把分镜表（镜号/景别/运镜/台词/时长）导出成 CSV，进项目 export/，给剪辑软件用"
          >
            分镜表
          </Btn>
          <IconBtn label="打开输出目录" onClick={onOpenDir}>
            {I.folder(13)}
          </IconBtn>
          <IconBtn
            label="从历史移除（不删文件）"
            className="hover:text-[var(--err)]"
            onClick={() => {
              if (window.confirm(`删除这条执行记录（${run.id}）？产物文件保留在磁盘。`))
                onDelete(run.id);
            }}
          >
            {I.trash(13)}
          </IconBtn>
        </div>
      </div>

      {plan.style || plan.characters.length ? (
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          {plan.style ? (
            <p className="min-w-[240px] max-w-[640px] flex-1 border-l-[1.5px] border-[var(--line-3)] pl-2.5 t-12 leading-[19px] text-[var(--fg-3)]">
              {plan.style}
            </p>
          ) : null}
          {plan.characters.length ? (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {plan.characters.map((c) => (
                <span
                  key={c.id}
                  title={c.anchor}
                  className="t-11 rounded-full bg-[var(--bg-2)] px-2 py-[2px] text-[var(--fg-3)]"
                >
                  {c.name}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-3">
        {film ? (
          <div className="overflow-hidden rounded-[14px] bg-[var(--bg-2)] shadow-[inset_0_0_0_0.5px_var(--line-2)]">
            <div className="flex items-center gap-2 px-3 py-2">
              <Tag tone="accent">成片</Tag>
              <span className="truncate t-11 font-mono text-[var(--fg-4)]">
                {film.filename}
                {film.duration ? ` · ${film.duration.toFixed(1)}s` : ""}
              </span>
              <div className="flex-1" />
              <Btn
                size="xs"
                variant="ghost"
                onClick={() => onZoom(film, run.assets.filter(isVideo))}
              >
                全屏
              </Btn>
            </div>
            <video
              src={mediaSrc(film)}
              controls
              preload="metadata"
              className="max-h-[420px] w-full bg-black"
              />
            </div>
          ) : null}

          <div className="grid content-start gap-3 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
            {order.map((shotIdx, pos) => (
              <div
                key={`${run.id}-${shotIdx}`}
                draggable={!busy}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(pos));
                  setDragFrom(pos);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDragTo(pos);
                }}
                onDragLeave={() => setDragTo((p) => (p === pos ? null : p))}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = Number(e.dataTransfer.getData("text/plain"));
                  endDrag();
                  if (Number.isFinite(from) && from !== pos) onMove(from, pos);
                }}
                onDragEnd={endDrag}
                className={cx(
                  "rounded-[12px] transition-[opacity,box-shadow] duration-150",
                  dragFrom === pos && "opacity-40",
                  dragTo === pos &&
                    dragFrom !== null &&
                    dragFrom !== pos &&
                    "shadow-[0_0_0_2px_var(--accent)]"
                )}
                title={busy ? undefined : "拖一下换位置"}
              >
                <ShotCard
                  run={run}
                  shot={plan.shots[shotIdx]}
                  index={shotIdx}
                  pos={pos}
                  onZoom={onZoom}
                  onRerun={(idx) => onRerun(run.id, idx)}
                  busy={busy}
                />
              </div>
            ))}
          </div>
        </div>

        {/* 逐镜实耗：一条代表一镜，灰条是排队、亮条是生成，太长的那条就是瓶颈 */}
        {spent ? (
          <div>
            <AsideLabel>逐镜实耗 · 灰=排队 亮=生成</AsideLabel>
            <div className="flex flex-wrap gap-1.5">
              {order.map((shotIdx, pos) => {
                const c = run.shotCost?.[String(shotIdx + 1)];
                const total = c ? c.wait + c.busy : 0;
                const w = total ? Math.max(6, Math.round((total / spent) * 100)) : 0;
                const waitPct = total ? Math.round(((c?.wait ?? 0) / total) * 100) : 0;
                return (
                  <div
                    key={shotIdx}
                    title={
                      c
                        ? `等 ${fmtMs(c.wait)} · 跑 ${fmtMs(c.busy)}${
                            c.retries ? ` · 重跑 ${c.retries} 次` : ""
                          }`
                        : "这一镜没有进度事件（多半整段命中缓存）"
                    }
                    className="flex items-center gap-2 rounded-[8px] bg-[var(--bg-1)] px-2 py-1 shadow-[inset_0_0_0_0.5px_var(--line-1)]"
                  >
                    <span className="tabular t-11 text-[var(--fg-4)]">{pad(pos + 1)}</span>
                    <div className="h-[4px] w-14 overflow-hidden rounded-full bg-[var(--bg-3)]">
                      <div className="flex h-full" style={{ width: `${w}%` }}>
                        <div
                          style={{
                            width: `${waitPct}%`,
                            background: "var(--fg-4)",
                            opacity: 0.5,
                          }}
                        />
                        <div
                          style={{
                            width: `${100 - waitPct}%`,
                            background: "var(--accent)",
                            opacity: 0.8,
                          }}
                        />
                      </div>
                    </div>
                    <span className="tabular t-11 text-[var(--fg-2)]">
                      {c ? fmtMs(c.busy) : "—"}
                    </span>
                    {c?.retries ? (
                      <span className="tabular t-11 text-[var(--warn)]">↻{c.retries}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
    </section>
  );
}

function AsideLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="t-11 tracking-[0.04em] text-[var(--fg-4)]">{children}</span>
      <div className="hairline flex-1" />
    </div>
  );
}

/** 资产页顶上那排小统计块 */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] bg-[var(--bg-1)] px-3 py-2 shadow-[inset_0_0_0_0.5px_var(--line-1)]">
      <div className="t-11 text-[var(--fg-4)]">{label}</div>
      <div className="mt-0.5 truncate t-13 tabular text-[var(--fg-1)]">{value}</div>
    </div>
  );
}

function LegacyRun({ run, onZoom }: { run: RunRecord; onZoom: (a: Asset, list: Asset[]) => void }) {
  const cover = run.assets.find((a) => !isVideo(a)) || run.assets[0];
  const list = run.assets.filter((a) => a.kind !== "audio");
  return (
    <section className="space-y-4 border-t-[0.5px] border-[var(--line-1)] pt-6 first:border-0 first:pt-0">
      <div className="flex items-center gap-2 border-b-[0.5px] border-[var(--line-1)] pb-3">
        <h2 className="truncate t-14 font-medium text-[var(--fg-1)]">
          {cover?.filename || run.note || "未命名执行"}
        </h2>
        <Tag tone={run.status === "done" ? "ok" : "warn"}>
          {run.status === "done" ? "完成" : run.status}
        </Tag>
        <span className="t-11 text-[var(--fg-4)]">早于分镜计划的执行</span>
        <div className="flex-1" />
        <span className="t-11 font-mono text-[var(--fg-4)]">{run.id}</span>
      </div>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
        {(list.length ? list : [undefined]).map((a, i) =>
          a ? (
            <div
              key={i}
              onClick={() => onZoom(a, list)}
              className="group cursor-zoom-in overflow-hidden rounded-[12px] bg-[var(--bg-base)] shadow-[inset_0_0_0_0.5px_var(--line-1)]"
              style={{ aspectRatio: "9 / 16" }}
            >
              {isVideo(a) ? (
                <div className="grid h-full place-items-center text-[var(--fg-3)]">{I.play(18)}</div>
              ) : (
                // 老记录里的产物尺寸不一定跟分镜一致（512 方图也常见），按比例塞进去，别裁
                <img src={mediaSrc(a)} alt="" className="size-full object-contain" />
              )}
            </div>
          ) : (
            <div
              key={i}
              className="grid place-items-center rounded-[12px] text-[var(--fg-4)]"
              style={{ aspectRatio: "9 / 16" }}
            >
              {I.image(18)}
            </div>
          )
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 多版对比：同一个计划跑了几版，并排看同一镜的差别
 * ------------------------------------------------------------------ */

function CompareBoard({
  runs,
  onZoom,
}: {
  runs: RunRecord[];
  onZoom: (a: Asset, list: Asset[]) => void;
}) {
  const rows = Math.max(...runs.map((r) => r.plan!.shots.length));
  return (
    <div
      className="grid justify-start gap-2.5"
      style={{ gridTemplateColumns: `34px repeat(${runs.length}, minmax(0, 232px))` }}
    >
      <div />
      {runs.map((r, i) => (
        <div
          key={r.id}
          className="min-w-0 rounded-[10px] bg-[var(--bg-1)] px-2.5 py-2 shadow-[inset_0_0_0_0.5px_var(--line-1)]"
        >
          <div className="flex items-center gap-1.5">
            <span className="truncate t-12 text-[var(--fg-1)]">
              {i === 0 ? "最新一版" : `往前第 ${i + 1} 版`}
            </span>
            {i === 0 ? <Tag tone="accent">最新</Tag> : null}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 t-11 tabular text-[var(--fg-4)]">
            <span className="font-mono">{r.id}</span>
            <Dot />
            <span>
              {new Date(r.startedAt).toLocaleString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <Dot />
            <span>{r.plan!.shots.length} 镜</span>
          </div>
        </div>
      ))}

      {Array.from({ length: rows }).map((_, row) => (
        <Fragment key={row}>
          <div className="pt-2 t-11 tabular text-[var(--fg-4)]">{pad(row + 1)}</div>
          {runs.map((r) => {
            const shot = r.plan!.shots[row];
            const frame = shotFrame(r, row + 1);
            const video = shotVideo(r, row + 1);
            const open = video || frame;
            const list = r.plan!.shots
              .map((_, i) => shotVideo(r, i + 1) || shotFrame(r, i + 1))
              .filter(Boolean) as Asset[];
            return (
              <div key={`${r.id}-${row}`} className="min-w-0">
                {open ? (
                  <div
                    onClick={() => onZoom(open, list)}
                    className="group relative cursor-zoom-in overflow-hidden rounded-[10px] bg-[var(--bg-base)] shadow-[inset_0_0_0_0.5px_var(--line-1)]"
                    style={{ aspectRatio: "9 / 16" }}
                  >
                    {video ? (
                      <div className="grid size-full place-items-center text-[var(--fg-3)]">
                        {I.play(16)}
                      </div>
                    ) : (
                      <img
                        src={mediaSrc(frame)}
                        alt={shot?.title || ""}
                        loading="lazy"
                        className="size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.02]"
                      />
                    )}
                  </div>
                ) : (
                  <div
                    className="grid place-items-center rounded-[10px] bg-[var(--bg-1)] t-11 text-[var(--fg-4)] shadow-[inset_0_0_0_0.5px_var(--line-1)]"
                    style={{ aspectRatio: "9 / 16" }}
                  >
                    {shot ? "未生成" : "—"}
                  </div>
                )}
                <div className="mt-1 truncate t-11 text-[var(--fg-3)]">
                  {shot ? shot.title : "这一版没有这一镜"}
                </div>
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 舞台
 * ------------------------------------------------------------------ */

export function Workspace({ chatOpen, onOpenChat }: { chatOpen: boolean; onOpenChat: () => void }) {
  const {
    runs,
    logs,
    tab,
    setTab,
    lastPrompt,
    rerunShot,
    busy,
    stage,
    draft,
    focus,
    focusNode,
    setDraftGraph,
    runDraft,
    cancelRun,
    resetDraft,
    assembleShots,
    exportRunAssets,
    exportStoryboard,
    deleteRun,
    openOutputDir,
    send,
    runNodes,
    runNow,
    clearLogs,
    moveShot,
    resetShotOrder,
  } = useStore();

  const [zoom, setZoom] = useState<{ list: Asset[]; index: number } | null>(null);
  const [assetKind, setAssetKind] = useState<"all" | "image" | "video">("all");

  const latest = runs[0];
  const allAssets = useMemo(
    () => runs.flatMap((r) => r.assets.map((a) => ({ ...a, runId: r.id }))),
    [runs]
  );
  const totalUsage = runs.reduce(
    (acc, r) => {
      const u = usageOf(r);
      return {
        llmTokens: acc.llmTokens + u.llmTokens,
        images: acc.images + u.images,
        videoSeconds: Math.round((acc.videoSeconds + u.videoSeconds) * 10) / 10,
      };
    },
    { llmTokens: 0, images: 0, videoSeconds: 0 }
  );

  const openZoom = (a: Asset, list: Asset[]) => {
    const idx = list.findIndex((x) => x.filename === a.filename);
    setZoom({ list: list.length ? list : [a], index: idx >= 0 ? idx : 0 });
  };

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoom(null);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        setZoom((z) => {
          if (!z) return z;
          const d = e.key === "ArrowRight" ? 1 : -1;
          return { ...z, index: (z.index + d + z.list.length) % z.list.length };
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  const current = zoom?.list[zoom.index];

  /** 灯箱缩放：true=适应窗口（永远能看到全貌），false=1:1 原始大小（可滚动平移） */
  const [fit, setFit] = useState(true);
  const wheelLock = useRef(0);
  useEffect(() => setFit(true), [current?.filename]);

  /** 画布上这一版还没执行完/还没执行：分镜页顶上摆一个跟着跑的版本 */
  const needsLive = !!draft.plan && draft.status !== "done";

  /** 可对比的版本：有分镜计划的执行记录 */
  const planRuns = runs.filter((r) => !!r.plan);
  const [compare, setCompare] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const sel = (picked.length ? picked : planRuns.slice(0, 2).map((r) => r.id))
    .map((id) => planRuns.find((r) => r.id === id))
    .filter(Boolean) as RunRecord[];
  const togglePick = (id: string) => {
    setPicked((cur) => {
      const base = cur.length ? cur : planRuns.slice(0, 2).map((r) => r.id);
      if (base.includes(id)) return base.filter((x) => x !== id);
      // 最多并排三版：再点就顶掉最早选的那一版
      return [...base, id].slice(-3);
    });
  };

  /** 执行历史列表：分镜页正常态的正文，抽出来避免两处写两遍 */
  const runSections = (
    <div className="space-y-10">
      {runs.map((run) =>
        run.plan ? (
          <PlanRun
            key={run.id}
            run={run}
            onZoom={openZoom}
            onRerun={rerunShot}
            busy={busy}
            onAssemble={(id) => void assembleShots(id)}
            onExport={(id) => void exportRunAssets(id)}
            onStoryboard={(id) => void exportStoryboard(id)}
            onDelete={deleteRun}
            onOpenDir={() => void openOutputDir()}
            onMove={(from, to) => moveShot(run.id, from, to)}
            onResetOrder={() => resetShotOrder(run.id)}
          />
        ) : (
          <LegacyRun key={run.id} run={run} onZoom={openZoom} />
        )
      )}
    </div>
  );

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-[var(--bg-base)]">
      <div className="flex h-12 shrink-0 items-end justify-between border-b-[0.5px] border-[var(--line-1)] px-5">
        <div className="no-select flex items-end">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              data-active={tab === t.id ? "1" : "0"}
              className="tab flex items-center"
            >
              {t.label}
              {t.id === "shots" && runs.length > 0 ? (
                <span className="ml-1.5 t-11 tabular text-[var(--fg-4)]">{runs.length}</span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="no-select flex items-center gap-2 pb-2">
          {latest ? (
            <span className="tabular mr-0.5 t-11 text-[var(--fg-4)]">
              {new Date(latest.startedAt).toLocaleString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          ) : null}
          <span className="h-3 w-px bg-[var(--line-2)]" />
          <IconBtn label="在资源管理器中打开输出目录" onClick={() => void openOutputDir()}>
            {I.folder(13)}
          </IconBtn>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cx(
            "mx-auto w-full",
            tab === "graph" ? "max-w-none px-4 py-3" : "max-w-[1180px] px-6 py-6"
          )}
        >
          {tab === "shots" && (
            <>
              {planRuns.length >= 2 ? (
                <div className="no-select mb-5 flex flex-wrap items-center gap-2">
                  <button
                    className="chip"
                    data-active={compare ? "1" : "0"}
                    onClick={() => setCompare((v) => !v)}
                  >
                    多版对比
                    <span className="tabular ml-1.5 text-[var(--fg-4)]">{planRuns.length}</span>
                  </button>
                  {compare ? (
                    <span className="t-11 text-[var(--fg-4)]">
                      同一镜并排看，最多三版
                    </span>
                  ) : null}
                </div>
              ) : null}

              {compare && sel.length >= 2 ? (
                <>
                  <CompareBoard runs={sel} onZoom={openZoom} />
                  <div className="no-select mt-5 flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 t-11 text-[var(--fg-4)]">挑版本</span>
                    {planRuns.map((r) => (
                      <button
                        key={r.id}
                        className="chip"
                        data-active={sel.some((x) => x.id === r.id) ? "1" : "0"}
                        onClick={() => togglePick(r.id)}
                        title={`${r.plan!.title} · ${new Date(r.startedAt).toLocaleString("zh-CN")}`}
                      >
                        <span className="font-mono">{r.id}</span>
                        <span className="ml-1.5 tabular text-[var(--fg-4)]">
                          {new Date(r.startedAt).toLocaleString("zh-CN", {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              ) : needsLive ? (
                <div className="space-y-10">
                  <LivePlan
                    plan={draft.plan!}
                    status={draft.status}
                    runNodes={runNodes}
                    busy={busy}
                    onRun={() => void runDraft()}
                    onStop={() => void cancelRun()}
                  />
                  {runs.length ? runSections : null}
                </div>
              ) : runs.length === 0 ? (
                <div className="grid min-h-[70vh] place-items-center">
                  <div className="text-center fade-in">
                    <div className="mx-auto mb-4 grid size-11 place-items-center rounded-[14px] bg-[var(--bg-2)] text-[var(--fg-3)] shadow-[inset_0_0_0_0.5px_var(--line-2)]">
                      {I.film(18)}
                    </div>
                    <div className="t-14 text-[var(--fg-2)]">还没有镜头</div>
                    <div className="mx-auto mt-1.5 max-w-[340px] t-12 leading-[19px] text-[var(--fg-3)]">
                      在左边说一句想拍什么，我把图搭到画布上；你在画布上改到满意，再点「开始生成」。
                    </div>
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                      <Btn
                        size="sm"
                        variant="primary"
                        icon={I.spark(12)}
                        onClick={() => void send("拍一个雨夜便利店门口的镜头")}
                      >
                        试一个镜头
                      </Btn>
                      <Btn
                        size="sm"
                        variant="outline"
                        onClick={() => setTab("graph")}
                        icon={I.node(12)}
                      >
                        直接搭工作流
                      </Btn>
                      {!chatOpen ? (
                        <Btn size="sm" variant="ghost" onClick={onOpenChat}>
                          展开导演台
                        </Btn>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : (
                runSections
              )}
            </>
          )}

          {tab === "graph" && (
            <div className="space-y-3">
              <CanvasGraph
                doc={draft}
                busy={busy}
                stage={stage}
                focus={focus}
                baseGraph={runs[0]?.graph ?? null}
                onGraphChange={setDraftGraph}
                onFocusNode={focusNode}
                onRun={() => void runDraft()}
                onCancel={() => void cancelRun()}
                onReset={resetDraft}
                runNodes={runNodes}
                runNow={runNow}
              />
              <div className="space-y-1 pt-1">
                <Disclosure title="原始 JSON" hint={`${Object.keys(draft.graph).length} 个节点`}>
                  <pre className="max-h-[360px] overflow-auto rounded-[10px] bg-[var(--bg-1)] p-3 t-11 font-mono leading-[17px] text-[var(--fg-3)] selectable">
                    {JSON.stringify(draft.graph, null, 2)}
                  </pre>
                </Disclosure>
                {lastPrompt ? (
                  <Disclosure
                    title="模型收到的提示词"
                    hint={`${lastPrompt.length.toLocaleString("en-US")} 字`}
                  >
                    <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-[10px] bg-[var(--bg-1)] p-3 t-11 font-mono leading-[17px] text-[var(--fg-3)] selectable">
                      {lastPrompt}
                    </pre>
                  </Disclosure>
                ) : null}
              </div>
            </div>
          )}

          {tab === "assets" && (
            <>
              {runs.length > 0 ? (
                <div className="mb-5 grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
                  <Stat label="累计用量" value={usageText(totalUsage)} />
                  <Stat label="执行次数" value={`${runs.length} 次`} />
                  <Stat label="文件" value={`${allAssets.length} 个`} />
                  <Stat
                    label="用时"
                    value={`${Math.round(
                      runs.reduce((a, r) => a + ((r.finishedAt ?? r.startedAt) - r.startedAt), 0) /
                        1000
                    )}s`}
                  />
                </div>
              ) : null}

              {allAssets.length === 0 ? (
                <Empty
                  icon={I.image(18)}
                  title="资产库是空的"
                  desc="每次执行的产出都会自动归档到这里。"
                />
              ) : (
                <>
                  <div className="no-select mb-3 flex items-center gap-1.5">
                    {(
                      [
                        ["all", "全部", allAssets.length],
                        ["image", "图片", allAssets.filter((a) => !isVideo(a)).length],
                        ["video", "视频", allAssets.filter(isVideo).length],
                      ] as const
                    ).map(([k, label, n]) => (
                      <button
                        key={k}
                        onClick={() => setAssetKind(k)}
                        data-active={assetKind === k ? "1" : "0"}
                        className="chip"
                        disabled={k !== "all" && n === 0}
                      >
                        {label}
                        <span className="tabular ml-1.5 text-[var(--fg-4)]">{n}</span>
                      </button>
                    ))}
                  </div>

                  <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(146px,1fr))]">
                    {allAssets
                      .filter((a) => (assetKind === "all" ? true : assetKind === "video" ? isVideo(a) : !isVideo(a)))
                      .map((a, i) => (
                        <button
                          key={`${a.runId}-${a.filename}-${i}`}
                          onClick={() =>
                            openZoom(a, allAssets.filter((x) => x.runId === a.runId))
                          }
                          className="group overflow-hidden rounded-[12px] bg-[var(--bg-1)] text-left shadow-[inset_0_0_0_0.5px_var(--line-1)] transition-shadow hover:shadow-[inset_0_0_0_0.5px_var(--line-3)]"
                        >
                          <div className="relative bg-[var(--bg-base)]" style={{ aspectRatio: "4 / 3" }}>
                            {isVideo(a) ? (
                              <div className="grid size-full place-items-center text-[var(--fg-3)]">
                                {I.play(18)}
                              </div>
                            ) : (
                              <img
                                src={mediaSrc(a)}
                                alt=""
                                loading="lazy"
                                className="size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.02]"
                              />
                            )}
                            <span className="pointer-events-none absolute right-1.5 top-1.5 t-11 tabular rounded-[4px] bg-black/55 px-1 py-px font-mono text-[var(--fg-2)] backdrop-blur-sm">
                              {isVideo(a) ? "MP4" : "PNG"}
                            </span>
                          </div>
                          <div className="px-2.5 py-2">
                            <div className="truncate t-11 font-mono text-[var(--fg-1)]">
                              {a.filename}
                            </div>
                            <div className="mt-0.5 truncate t-11 text-[var(--fg-4)]">
                              {a.nodeId ? `节点 ${a.nodeId}` : a.subfolder || "output"}
                              {a.duration ? ` · ${a.duration.toFixed(1)}s` : ""}
                            </div>
                          </div>
                        </button>
                      ))}
                  </div>
                </>
              )}
            </>
          )}

          {tab === "logs" && (
            <div className="overflow-hidden rounded-[12px] bg-[var(--bg-1)] shadow-[inset_0_0_0_0.5px_var(--line-1)]">
              <div className="no-select flex h-9 items-center gap-2.5 border-b-[0.5px] border-[var(--line-1)] px-3">
                <span className="t-12 text-[var(--fg-2)]">运行日志</span>
                <span className="tabular t-11 text-[var(--fg-4)]">
                  {logs.length} 条 · 保留最近 300 条
                </span>
                <div className="flex-1" />
                {logs.length ? (
                  <button
                    onClick={clearLogs}
                    className="t-11 text-[var(--fg-4)] transition-colors hover:text-[var(--err)]"
                  >
                    清空
                  </button>
                ) : null}
              </div>

              {logs.length === 0 ? (
                <div className="py-16 text-center t-12 text-[var(--fg-4)]">暂无日志</div>
              ) : (
                <div className="max-h-[calc(100vh-232px)] overflow-y-auto py-1 font-mono text-[11.5px] leading-[19px] selectable">
                  {logs.map((l, i) => (
                    <div
                      key={i}
                      className="flex gap-3 px-3 py-[3px] transition-colors hover:bg-[var(--bg-2)]"
                    >
                      <span className="tabular shrink-0 text-[var(--fg-4)]">
                        {new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false })}
                      </span>
                      <span
                        className={cx(
                          "w-[26px] shrink-0",
                          l.level === "error"
                            ? "text-[var(--err)]"
                            : l.level === "warn"
                              ? "text-[var(--warn)]"
                              : "text-[var(--fg-4)]"
                        )}
                      >
                        {l.level === "error" ? "错误" : l.level === "warn" ? "警告" : "信息"}
                      </span>
                      <span className="min-w-0 flex-1 break-words text-[var(--fg-2)]">
                        {l.text}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {current ? (
        <div
          className="fixed inset-0 z-50 bg-black/92 backdrop-blur-sm fade-in"
          onClick={() => setZoom(null)}
          onWheel={(e) => {
            // 滚轮切换适应/1:1。滚动手势会连发几十个事件，这里锁 400ms 并顺延：
            // 连续滚动（无论快慢）只切一次，停手 400ms 后再滚才是下一次
            const now = Date.now();
            if (now - wheelLock.current > 400) {
              setFit((f) => !f);
            }
            wheelLock.current = now;
          }}
        >
          {/* 不用 grid place-items-center：网格轨道会被媒体固有尺寸撑爆，
              max-h 百分比失效导致竖屏视频超出视口。flex + calc 上限是稳的 */}
          <div className="flex h-full w-full items-center justify-center overflow-auto px-12 py-10">
            {isVideo(current) ? (
              <video
                key={current.url}
                src={mediaSrc(current)}
                controls
                autoPlay
                onClick={(e) => e.stopPropagation()}
                className={cx(
                  "shrink-0 rounded-[10px] shadow-2xl",
                  fit ? "max-h-[calc(100vh-5rem)] max-w-[calc(100vw-6rem)]" : "max-h-none max-w-none"
                )}
              />
            ) : (
              <img
                key={current.url}
                src={mediaSrc(current)}
                alt=""
                onClick={(e) => {
                  e.stopPropagation();
                  setFit((f) => !f);
                }}
                className={cx(
                  "shrink-0 rounded-[10px] shadow-2xl",
                  fit
                    ? "max-h-[calc(100vh-5rem)] max-w-[calc(100vw-6rem)] object-contain cursor-zoom-in"
                    : "max-h-none max-w-none cursor-zoom-out"
                )}
              />
            )}
          </div>

          <div className="absolute inset-x-0 top-0 flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 truncate t-11 font-mono text-[var(--fg-3)]">
              {current.filename}
            </span>
            <div className="flex-1" />
            {zoom && zoom.list.length > 1 ? (
              <span className="t-11 tabular text-[var(--fg-4)]">
                {zoom.index + 1} / {zoom.list.length}
              </span>
            ) : null}
            <Btn
              size="xs"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setFit((f) => !f);
              }}
              title="切换显示大小（也可以用滚轮或点图片）"
            >
              {fit ? "1:1 原始大小" : "适应窗口"}
            </Btn>
            <IconBtn label="关闭 (Esc)" onClick={() => setZoom(null)}>
              {I.close(14)}
            </IconBtn>
          </div>

          {zoom && zoom.list.length > 1 ? (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setZoom({ ...zoom, index: (zoom.index - 1 + zoom.list.length) % zoom.list.length });
                }}
                className="absolute left-3 grid size-9 place-items-center rounded-full bg-white/8 text-white/80 backdrop-blur transition-colors hover:bg-white/16"
                title="上一张 (←)"
              >
                {I.arrowLeft(16)}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setZoom({ ...zoom, index: (zoom.index + 1) % zoom.list.length });
                }}
                className="absolute right-3 grid size-9 place-items-center rounded-full bg-white/8 text-white/80 backdrop-blur transition-colors hover:bg-white/16"
                title="下一张 (→)"
              >
                {I.arrowRight(16)}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Disclosure({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group rounded-[10px] px-1">
      <summary className="no-select flex cursor-pointer list-none items-center gap-1.5 py-1.5 t-12 text-[var(--fg-3)] transition-colors hover:text-[var(--fg-1)]">
        <span className="transition-transform group-open:rotate-90">{I.chevronRight(11)}</span>
        {title}
        {hint ? <span className="t-11 text-[var(--fg-4)]">{hint}</span> : null}
      </summary>
      <div className="pb-1.5">{children}</div>
    </details>
  );
}
