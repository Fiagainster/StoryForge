import { test } from "node:test";
import assert from "node:assert/strict";
import { autonomousDecision, buildAutonomousMessages } from "./autonomous.js";

/* ------------------------------------------------------------------ *
 * 自主执行循环：决策与提示词的纯函数测试（不触发生成、不碰内核）
 * ------------------------------------------------------------------ */

const base = {
  round: 1,
  maxRounds: 4,
  spentCny: 0,
  maxCny: 100,
  lastRunOk: false,
  modelDone: false,
  cancelled: false,
};

test("autonomousDecision：取消最高优先，无论轮数预算", () => {
  const d = autonomousDecision({ ...base, cancelled: true });
  assert.equal(d.action, "abort");
  if (d.action !== "abort") throw new Error("unreachable");
  assert.match(d.why, /取消/);
});

test("autonomousDecision：modelDone 只在上一轮顺利时兑现", () => {
  const ok = autonomousDecision({ ...base, round: 2, spentCny: 12, lastRunOk: true, modelDone: true });
  assert.equal(ok.action, "done");
  // 上轮失败，模型嘴上说达标也不算——声明不等于事实
  const lie = autonomousDecision({ ...base, round: 2, spentCny: 12, lastRunOk: false, modelDone: true });
  assert.equal(lie.action, "run");
});

test("autonomousDecision：轮数上限止损", () => {
  const d = autonomousDecision({ ...base, round: 2, maxRounds: 2, spentCny: 5 });
  assert.equal(d.action, "abort");
  if (d.action !== "abort") throw new Error("unreachable");
  assert.match(d.why, /轮数上限/);
});

test("autonomousDecision：预算耗尽止损，文案带金额", () => {
  const d = autonomousDecision({ ...base, spentCny: 20.011, maxCny: 20 });
  assert.equal(d.action, "abort");
  if (d.action !== "abort") throw new Error("unreachable");
  assert.match(d.why, /¥20\.01/);
  assert.match(d.why, /¥20\.00/);
});

test("autonomousDecision：预算内且未达标 → 继续跑", () => {
  const d = autonomousDecision({ ...base, spentCny: 5, maxCny: 20 });
  assert.deepEqual(d, { action: "run" });
});

test("buildAutonomousMessages：第一轮不带上一轮结果，规则齐全", () => {
  const [system, user] = buildAutonomousMessages("雨夜追逃 30 秒", 1, 2, 0, 20, "不该出现", []);
  assert.match(system.content, /自主拍摄智能体/);
  assert.match(system.content, /¥20\.00/);
  assert.match(system.content, /已花 ¥0\.00/);
  assert.ok(!/不该出现/.test(system.content), "第一轮不应出现上一轮摘要");
  assert.match(system.content, /第一轮永远不要说 true/);
  assert.match(user.content, /雨夜追逃 30 秒/);
  assert.match(user.content, /第一版拍摄计划/);
});

test("buildAutonomousMessages：修订轮带上一轮结果与经验注入", () => {
  const [system, user] = buildAutonomousMessages(
    "雨夜追逃 30 秒",
    2,
    3,
    8.4,
    20,
    "产出 3 个文件，花费 ¥8.40；自审发现：实测时长偏差 2.1s",
    ["即梦只支持 5s/10s 两档"]
  );
  assert.match(system.content, /已花 ¥8\.40/);
  assert.match(system.content, /实测时长偏差 2\.1s/);
  assert.match(system.content, /已沉淀的经验/);
  assert.match(system.content, /即梦只支持 5s\/10s 两档/);
  assert.match(user.content, /修订后的完整计划/);
});

test("buildAutonomousMessages：无经验时不渲染经验段", () => {
  const [system] = buildAutonomousMessages("目标", 1, 2, 0, 10, "", []);
  assert.ok(!/已沉淀的经验/.test(system.content));
});
