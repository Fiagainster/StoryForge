import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyBudget,
  compilePlan,
  maxShotOf,
  parsePlan,
  storyboardCsv,
} from "./plan.js";
import type { DramaPlan } from "../types";

const basePlan = (): DramaPlan => ({
  title: "测试片",
  mode: "video",
  style: "竖屏 9:16，霓虹雨夜",
  characters: [{ id: "c1", name: "小雨", anchor: "二十岁女性，黑色短发" }],
  shots: [
    {
      title: "开场",
      characters: ["c1"],
      location: "天台",
      action: "她站在天台边缘望向城市",
      emotion: "平静",
      dialogue: "小雨：走吧。",
      shotSize: "中景",
      camera: "固定",
      duration: 6,
      generateAudio: true,
    },
    {
      title: "回望",
      characters: ["c1"],
      location: "天台",
      action: "她转身回望",
      emotion: "不安",
      dialogue: "",
      shotSize: "近景",
      camera: "缓慢推近",
      duration: 5,
      generateAudio: false,
    },
  ],
});

const compileOpts = {
  imageModel: "img",
  imageSize: "1080x1920",
  videoModel: "vid",
  videoResolution: "720p",
  generateAudio: true,
  withVideo: true,
  continuity: true,
};

test("parsePlan：有台词但关配音 → 自动打开", () => {
  const raw = basePlan();
  raw.shots[0].generateAudio = false;
  const { plan, warnings } = parsePlan(raw);
  assert.equal(plan.shots[0].generateAudio, true);
  assert.ok(warnings.some((w) => w.includes("自动打开")));
});

test("parsePlan：纯环境音镜头保持不配音", () => {
  const { plan } = parsePlan(basePlan());
  assert.equal(plan.shots[1].generateAudio, false);
});

test("parsePlan：非法景别回退中景并告警", () => {
  const raw = basePlan();
  (raw.shots[0] as any).shotSize = "航拍";
  const { plan, warnings } = parsePlan(raw);
  assert.equal(plan.shots[0].shotSize, "中景");
  assert.ok(warnings.some((w) => w.includes("景别")));
});

test("parsePlan：duration 钳制在 4-15", () => {
  const raw = basePlan();
  raw.shots[0].duration = 99;
  const { plan } = parsePlan(raw);
  assert.equal(plan.shots[0].duration, 15);
});

test("compilePlan：两镜视频图，连线与终点齐", () => {
  const g = compilePlan(basePlan(), compileOpts);
  assert.ok(g["shot_1_frame"] && g["shot_1_video"] && g["shot_1_save"] && g["shot_1_save_video"]);
  // 最后一镜没有下一镜，不产尾帧节点
  assert.ok(g["shot_1_tail"], "第 1 镜应有尾帧节点");
  assert.equal(g["shot_2_tail"], undefined);
  // 尾帧接续：第 2 镜首帧接第 1 镜尾帧
  assert.deepEqual(g["shot_2_frame"].inputs.previous_frame, ["shot_1_tail", 0]);
  // 第 1 镜没有上一镜，不接 previous_frame
  assert.equal(g["shot_1_frame"].inputs.previous_frame, undefined);
  assert.equal(g["shot_1_save"].inputs.filename_prefix, "storyforge/shot01_frame");
});

test("compilePlan：追加模式——从 startShot 接着编号，接上旧尾帧", () => {
  const plan = basePlan();
  plan.shots = [plan.shots[0]];
  const g = compilePlan(plan, { ...compileOpts, startShot: 4, prevTail: "shot_3_tail" });
  assert.ok(g["shot_4_frame"] && g["shot_4_video"]);
  assert.equal(g["shot_1_frame"], undefined);
  assert.deepEqual(g["shot_4_frame"].inputs.previous_frame, ["shot_3_tail", 0]);
  assert.equal(g["shot_4_save"].inputs.filename_prefix, "storyforge/shot04_frame");
});

test("compilePlan：追加模式——同名角色复用旧定妆节点，新角色 id 错开", () => {
  const plan = basePlan();
  plan.shots = [plan.shots[0]];
  const reuse = new Map([["小雨", "char_c1"]]);
  const g = compilePlan(plan, { ...compileOpts, startShot: 2, reuseChars: reuse });
  // 复用：不新建 char 节点，直接引用旧 id
  assert.equal(g["char_c1"], undefined);
  assert.deepEqual(g["shot_2_frame"].inputs.character1, ["char_c1", 0]);
  assert.deepEqual(g["shot_2_video"].inputs.character1_url, ["char_c1", 1]);
});

test("maxShotOf：认出图里最大镜号", () => {
  const g = compilePlan(basePlan(), compileOpts);
  assert.equal(maxShotOf(g), 2);
  assert.equal(maxShotOf({}), 0);
  assert.equal(maxShotOf({ char_c1: { class_type: "DramaCharacter", inputs: {} } as any }), 0);
});

test("applyBudget：超镜数截断，超总时长从尾部去", () => {
  const plan = basePlan();
  plan.shots.push({ ...plan.shots[0], title: "第三镜" });
  const { plan: cut, warnings } = applyBudget(plan, { maxShots: 2, maxSeconds: 99 });
  assert.equal(cut.shots.length, 2);
  assert.ok(warnings.length >= 1);

  const { plan: cut2, warnings: w2 } = applyBudget(basePlan(), { maxShots: 9, maxSeconds: 8 });
  assert.equal(cut2.shots.length, 1);
  assert.ok(w2.some((w) => w.includes("总时长")));
});

test("storyboardCsv：BOM、出片顺序、引号转义", () => {
  const plan = basePlan();
  plan.shots[0].dialogue = '小雨：说"走吧"，然后走。';
  const csv = storyboardCsv(plan, [1, 0]); // 拖序：第 2 镜排最前
  assert.ok(csv.startsWith("\uFEFF"));
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines.length, 3);
  const row1 = lines[1].split(",");
  assert.equal(row1[0], "1"); // 出片顺序 1
  assert.equal(row1[1], "2"); // 原镜号 2
  // 台词里的引号被转义且含逗号安全
  assert.ok(csv.includes('""走吧""'));
});
