import { test } from "node:test";
import assert from "node:assert/strict";
import { planRisk } from "./planRisk.js";
import type { DramaPlan, DramaShot } from "../types";

const shot = (over: Partial<DramaShot> = {}): DramaShot => ({
  title: "镜",
  characters: [],
  location: "便利店",
  action: "她推门进店，拿起饭团",
  shotSize: "中景",
  camera: "固定",
  duration: 5,
  ...over,
});

const plan = (shots: DramaShot[]): DramaPlan => ({
  title: "测试",
  mode: "video",
  style: "",
  characters: [],
  shots,
});

test("空计划直接 fail", () => {
  const r = planRisk(plan([]));
  assert.equal(r.verdict, "fail");
});

test("镜头太少不扣惯性分：单镜是 strong", () => {
  const r = planRisk(plan([shot()]));
  assert.equal(r.verdict, "strong");
});

test("全中景 + 全固定 + 全 5s + 无情绪 → revise 级别，带具体镜号建议", () => {
  const r = planRisk(
    plan([
      shot({ action: "她推门进店" }),
      shot({ action: "她拿起饭团" }),
      shot({ action: "她走向收银台" }),
      shot({ action: "她付钱离开" }),
    ])
  );
  assert.ok(["revise", "fail"].includes(r.verdict), `verdict=${r.verdict} avg=${r.average}`);
  const names = r.dimensions.map((d) => d.name);
  assert.ok(names.includes("景别重复"));
  assert.ok(names.includes("运镜多样性"));
  // 建议要指到具体镜号
  assert.ok(r.suggestions.some((s) => s.includes("镜")), r.suggestions.join("；"));
  assert.ok(r.suggestions.some((s) => s.includes("固定") || s.includes("推近")));
});

test("景别错落 + 运镜有变化 + 时长有起伏 + 情绪齐全 → strong", () => {
  const r = planRisk(
    plan([
      shot({ shotSize: "远景", camera: "缓慢推近", duration: 7, emotion: "平静", action: "街角路灯下她站定" }),
      shot({ shotSize: "中景", camera: "跟拍", duration: 5, emotion: "紧张", action: "她快步穿过马路" }),
      shot({ shotSize: "特写", camera: "固定", duration: 4, emotion: "哽咽", action: "她攥紧了车票" }),
      shot({ shotSize: "近景", camera: "手持", duration: 8, emotion: "释然", action: "她抬头看站台的时刻牌" }),
    ])
  );
  assert.equal(r.verdict, "strong");
  assert.deepEqual(r.suggestions, []);
});

test("台词全压一镜（>=4 镜）要提示", () => {
  const r = planRisk(
    plan([
      shot({ dialogue: "你到底想说什么" }),
      shot({ action: "他沉默地低头" }),
      shot({ action: "窗外的雨更大了" }),
      shot({ action: "她转身离开" }),
    ])
  );
  const d = r.dimensions.find((x) => x.name === "台词分布");
  assert.ok(d && d.score > 0, JSON.stringify(d));
});

test("动作描述雷同被独立维度抓出来", () => {
  const r = planRisk(
    plan([
      shot({ action: "她看着窗外的雨发呆" }),
      shot({ action: "她看着窗外的雨发呆" }),
      shot({ action: "她看着窗外的雨发呆" }),
      shot({ action: "门铃响了，她回头" }),
    ])
  );
  const d = r.dimensions.find((x) => x.name === "动作雷同");
  assert.ok(d && d.score > 0);
});
