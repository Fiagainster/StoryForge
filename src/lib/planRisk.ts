import type { DramaPlan, DramaShot } from "../types";

/**
 * P1-1 分镜风险评分：移植 OpenMontage slideshow_risk 的六维启发式，
 * 适配短剧语义。每维 0-5 分（越低越好），平均分给 verdict：
 *   < 2.0 strong / < 3.0 acceptable / < 4.0 revise / >= 4.0 fail
 *
 * 这查的不是"计划对不对"（graphAudit 管），是"这版拍出来会不会很平"——
 * 景别全是中景、运镜全是固定、动作描述雷同、节奏全是 5s，都属此类。
 */

export interface RiskDimension {
  name: string;
  score: number;
  reason: string;
}

export interface PlanRisk {
  average: number;
  verdict: "strong" | "acceptable" | "revise" | "fail";
  dimensions: RiskDimension[];
  /** revise / fail 时给的具体改法，喂给出计划的提示词 */
  suggestions: string[];
}

const VERDICTS = ["strong", "acceptable", "revise", "fail"] as const;

function verdictOf(avg: number): PlanRisk["verdict"] {
  if (avg < 2.0) return "strong";
  if (avg < 3.0) return "acceptable";
  if (avg < 4.0) return "revise";
  return "fail";
}

/** 前 50 字归一化（小写、去空白）后去重率 */
function uniqueRatio(texts: string[]): number {
  const norm = texts.map((t) => t.toLowerCase().replace(/\s+/g, "").slice(0, 50));
  return new Set(norm).size / Math.max(1, norm.length);
}

function modeRatio<T>(items: T[]): [T | null, number] {
  const counter = new Map<T, number>();
  for (const it of items) counter.set(it, (counter.get(it) ?? 0) + 1);
  let best: T | null = null;
  let bestN = 0;
  for (const [k, n] of counter) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return [best, items.length ? bestN / items.length : 0];
}

/** 景别重复：同一景别占比 >60% 扣分，并指出具体镜号 */
function scoreShotSize(shots: DramaShot[]): RiskDimension {
  if (shots.length < 3) {
    return { name: "景别重复", score: 0, reason: "镜头太少，看不出景别惯性" };
  }
  const sizes = shots.map((s) => s.shotSize);
  const [dominant, ratio] = modeRatio(sizes);
  if (dominant && ratio > 0.6) {
    const idx = shots
      .map((s, i) => (s.shotSize === dominant ? i + 1 : 0))
      .filter((n) => n > 0);
    return {
      name: "景别重复",
      score: 2.5,
      reason: `${Math.round(ratio * 100)}% 的镜都是「${dominant}」（第 ${idx.join("、")} 镜）`,
    };
  }
  return { name: "景别重复", score: 0, reason: "景别有变化" };
}

/** 运镜多样性：全固定记中档，固定占比 >60% 扣分 */
function scoreCamera(shots: DramaShot[]): RiskDimension {
  if (shots.length < 3) {
    return { name: "运镜多样性", score: 0, reason: "镜头太少，看不出运镜惯性" };
  }
  const fixed = shots.filter((s) => s.camera === "固定").length;
  const ratio = fixed / shots.length;
  if (ratio === 1) {
    return { name: "运镜多样性", score: 1.5, reason: "全部镜头都是固定机位（可能是刻意的静态风格）" };
  }
  if (ratio > 0.6) {
    return {
      name: "运镜多样性",
      score: 2.0,
      reason: `${fixed}/${shots.length} 镜是固定机位，画面容易呆`,
    };
  }
  return { name: "运镜多样性", score: 0, reason: "运镜有变化" };
}

/** 动作描述相似度：多镜动作雷同 → 拍出来像复制粘贴 */
function scoreAction(shots: DramaShot[]): RiskDimension {
  if (shots.length < 3) {
    return { name: "动作雷同", score: 0, reason: "镜头太少，看不出描述惯性" };
  }
  const r = uniqueRatio(shots.map((s) => s.action || ""));
  if (r < 0.6) {
    return {
      name: "动作雷同",
      score: 2.0,
      reason: `动作描述只有 ${Math.round(r * 100)}% 不重复，拍出来像同一镜`,
    };
  }
  return { name: "动作雷同", score: 0, reason: "每镜动作各有其事" };
}

/** 时长节奏：全片同一时长 → 节奏平；有长短错落 → 加分（0 分） */
function scoreDuration(shots: DramaShot[]): RiskDimension {
  if (shots.length < 3) {
    return { name: "时长节奏", score: 0, reason: "镜头太少，谈不上节奏" };
  }
  const durations = new Set(shots.map((s) => s.duration));
  if (durations.size === 1) {
    const d = shots[0].duration;
    return {
      name: "时长节奏",
      score: 1.5,
      reason: `全部 ${d}s——均匀节奏拍出来像流水账，高潮镜该短、铺垫镜该长`,
    };
  }
  return { name: "时长节奏", score: 0, reason: "时长有长短错落" };
}

/** 台词分布：全片台词压在一镜上 → 播放时头重脚轻；没台词只记一笔 */
function scoreDialogue(shots: DramaShot[]): RiskDimension {
  const withLines = shots.map((s, i) => ({ i: i + 1, d: (s.dialogue || "").trim() })).filter((x) => x.d);
  if (withLines.length === 0) {
    return { name: "台词分布", score: 0.5, reason: "全片没有台词（哑剧式短剧？确认是刻意的）" };
  }
  if (shots.length >= 4 && withLines.length === 1) {
    return {
      name: "台词分布",
      score: 1.5,
      reason: `台词全部压在第 ${withLines[0].i} 镜，其余镜全程沉默`,
    };
  }
  return { name: "台词分布", score: 0, reason: "台词分布正常" };
}

/** 情绪覆盖：大部分镜没写情绪 → 模型只能演"面无表情" */
function scoreEmotion(shots: DramaShot[]): RiskDimension {
  const withEmotion = shots.filter((s) => (s.emotion || "").trim()).length;
  const ratio = withEmotion / shots.length;
  if (ratio < 0.3) {
    return {
      name: "情绪覆盖",
      score: 2.0,
      reason: `只有 ${withEmotion}/${shots.length} 镜写了情绪，模型容易演成面瘫`,
    };
  }
  if (ratio < 0.6) {
    return { name: "情绪覆盖", score: 1.0, reason: `${withEmotion}/${shots.length} 镜写了情绪` };
  }
  return { name: "情绪覆盖", score: 0, reason: "情绪覆盖充分" };
}

/** 对一份分镜计划打风险分 */
export function planRisk(plan: DramaPlan): PlanRisk {
  const shots = plan.shots ?? [];
  if (shots.length === 0) {
    return { average: 5, verdict: "fail", dimensions: [], suggestions: ["计划里没有镜头"] };
  }
  const dimensions = [
    scoreShotSize(shots),
    scoreCamera(shots),
    scoreAction(shots),
    scoreDuration(shots),
    scoreDialogue(shots),
    scoreEmotion(shots),
  ];
  const average = Math.round((dimensions.reduce((n, d) => n + d.score, 0) / dimensions.length) * 100) / 100;
  const verdict = verdictOf(average);

  // revise / fail 时给具体改法：指着镜号说
  const suggestions: string[] = [];
  for (const d of dimensions) {
    if (d.score <= 0) continue;
    if (d.name === "景别重复") {
      const sizes = shots.map((s) => s.shotSize);
      const [dominant] = modeRatio(sizes);
      const idx = shots.map((s, i) => (s.shotSize === dominant ? i + 1 : 0)).filter((n) => n > 0);
      if (idx.length >= 2) {
        suggestions.push(`第 ${idx[0]}、${idx[1]} 镜都是「${dominant}」，建议把第 ${idx[1]} 镜改近景或特写`);
      }
    } else if (d.name === "运镜多样性" && shots.every((s) => s.camera === "固定")) {
      suggestions.push("全部固定机位，建议给情绪最强的镜头加「缓慢推近」或「跟拍」");
    } else if (d.name === "时长节奏") {
      suggestions.push("把情绪高潮镜压到 4-5s、铺垫镜放宽到 7-8s，节奏才有起伏");
    } else if (d.name === "情绪覆盖") {
      suggestions.push("给每个镜头补上具体情绪（如「强忍泪水」「故作镇定」）");
    } else if (d.name === "台词分布" || d.name === "动作雷同") {
      suggestions.push(d.reason);
    }
  }
  return { average, verdict, dimensions, suggestions };
}

export const RISK_VERDICT_LABEL: Record<PlanRisk["verdict"], string> = {
  strong: "扎实",
  acceptable: "可用",
  revise: "建议改",
  fail: "重出",
};

export const RISK_VERDICT_TONE: Record<PlanRisk["verdict"], "ok" | "warn" | "err" | "accent"> = {
  strong: "ok",
  acceptable: "accent",
  revise: "warn",
  fail: "err",
};

export { VERDICTS };
