import type { DramaPlan } from "../types";

/* ------------------------------------------------------------------ *
 * 自主执行循环：纯逻辑层（决策 + 提示词构造）。
 * 执行层在 agent.ts 的 autonomousRun——这里只放可单测的纯函数，
 * 测试不拖 Tauri/ComfyClient 依赖链。
 * ------------------------------------------------------------------ */

export interface AutonomousRequest {
  /** 对用户拍摄意图的完整重述（题材/风格/时长/镜数偏好都在里面） */
  goal: string;
  /** 最多迭代几轮（1-4，默认 2） */
  maxRounds?: number;
}

/** 自主轮计划的结构约束（与普通 DramaPlan 同形，done 时缺省） */
export type AutonomousPlanPayload = DramaPlan;

export interface AutonomousDecisionInput {
  /** 已完成的轮数 */
  round: number;
  maxRounds: number;
  spentCny: number;
  maxCny: number;
  /** 上一轮执行是否顺利（无错误且有产物） */
  lastRunOk: boolean;
  /** 模型是否声明目标已达成 */
  modelDone: boolean;
  cancelled: boolean;
}

export type AutonomousAction =
  | { action: "done"; why: string }
  | { action: "abort"; why: string }
  | { action: "run" };

/** 纯函数：自主循环的下一步决策。 */
export function autonomousDecision(i: AutonomousDecisionInput): AutonomousAction {
  if (i.cancelled) return { action: "abort", why: "已取消" };
  if (i.modelDone && i.lastRunOk) {
    return { action: "done", why: "模型确认达标且上一轮执行无误" };
  }
  if (i.round >= i.maxRounds) {
    return { action: "abort", why: `已达轮数上限（${i.maxRounds} 轮）` };
  }
  if (i.spentCny >= i.maxCny) {
    return {
      action: "abort",
      why: `累计花费 ¥${i.spentCny.toFixed(2)} 已达总预算 ¥${i.maxCny.toFixed(2)}`,
    };
  }
  return { action: "run" };
}

/** 自主轮的对话消息构造（纯函数）。 */
export function buildAutonomousMessages(
  goal: string,
  round: number,
  maxRounds: number,
  spentCny: number,
  maxCny: number,
  lastSummary: string,
  lessons: string[]
): { role: "system" | "user"; content: string }[] {
  const lessonText = lessons.length
    ? `\n## 已沉淀的经验（务必规避）\n${lessons.map((l) => `- ${l}`).join("\n")}\n`
    : "";
  const lastText =
    round === 1
      ? ""
      : `\n## 上一轮执行结果（这是你要修订的依据）\n${lastSummary}\n`;
  const system = `你是 StoryForge 的自主拍摄智能体。用户给了一个拍摄目标，你将连续执行最多 ${maxRounds} 轮：每轮出一份完整计划 → 系统自动执行 → 产物自审。用户中途不逐版确认，安全闸是总预算 ¥${maxCny.toFixed(2)}（已花 ¥${spentCny.toFixed(2)}），预算耗尽一切停止。

## 输出（严格 JSON，不要 markdown）
{"reply":"这一轮的思路，一句话","done":false,"plan":{...},"lesson":"可选，一句本轮经验"}

- "done": true 表示目标已达成——只有在上一轮确实顺利产出的前提下才能说 true；第一轮永远不要说 true。
- "done": false 时必须给完整 plan（整版重新执行，超出预算会被截断）。
- plan 结构与普通计划完全一致：{"title","mode","style","characters":[{"id","name","anchor"}],"shots":[{"title","characters","location","action","emotion","dialogue","shotSize","camera","duration","generateAudio"}]}
- 硬规则：默认克制 1-3 镜；每镜最多 2 个动作拍，一句一拍；台词快剪每句 ≤6 词；style 写具体影调光线（禁"高级感/电影感"）；角色锚点逐字复用；画面内无文字水印。
- 修订策略：上一轮没问题的镜头尽量逐字保留（省预算），只动确实要改的；动作超 2 个就拆镜。
${lastText}${lessonText}`;
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `拍摄目标：${goal}${lastText}\n\n请给出${
        round === 1 ? "第一版拍摄计划" : "修订后的完整计划（若确已完成则 done=true）"
      }。`,
    },
  ];
}
