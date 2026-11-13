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

test("动作迁移：背景先出空镜，再让定妆把人物放进去", () => {
  const { plan, warnings } = parsePlan({
    title: "古风舞",
    mode: "motion",
    style: "古风仙侠，淡青冷调",
    characters: [{ id: "c1", name: "阿瑶", anchor: "浅蓝交领广袖汉服" }],
    motion: {
      referenceVideo: "C://Users//x//dance.mp4",
      characterRef: "face.jpg",
      scene: "云海翻涌的仙山之巅",
      animateMode: "wan-pro",
      referenceSeconds: 20,
    },
    shots: [],
  });
  assert.equal(plan.mode, "motion");
  assert.equal(warnings.length, 0);
  // 路径被收敛成文件名：内核只认 input/ 下的相对名
  assert.equal(plan.motion?.referenceVideo, "dance.mp4");
  // 没给镜头也要有一条，分镜板才有卡可看
  assert.equal(plan.shots.length, 1);
  assert.equal(plan.shots[0].duration, 20);

  const graph = compilePlan(plan, {
    imageModel: "doubao-seedream-5-0-pro-260628",
    imageSize: "1080x1920",
    videoModel: "doubao-seedance-2-5-260628",
    videoResolution: "720p",
    generateAudio: false,
    withVideo: true,
    continuity: true,
  });

  // 背景是「背景唯一真相」，必须单独落盘，后续镜头才能复用
  assert.ok(graph.motion_bg);
  assert.equal(graph.motion_bg.class_type, "DramaBackdrop");
  assert.deepEqual(graph.motion_bg_save.inputs.images, ["motion_bg", 0]);
  // 定妆同时吃脸和场景：脸在前、背景在后
  assert.deepEqual(graph.motion_char.inputs.reference_image, ["motion_face", 0]);
  assert.deepEqual(graph.motion_char.inputs.backdrop, ["motion_bg", 0]);
  assert.equal(graph.motion_char.inputs.framing, "全身");
  // 动作迁移吃规整后的视频，不吃原片
  assert.deepEqual(graph.shot_1_video.inputs.video, ["motion_fit", 0]);
  assert.equal(graph.shot_1_video.inputs.mode, "wan-pro");
  assert.deepEqual(graph.shot_1_save.inputs.video, ["shot_1_video", 0]);
});

test("动作迁移：不给场景就不出背景节点，只靠文字锚点", () => {
  const { plan } = parsePlan({
    title: "纯动作",
    mode: "motion",
    style: "",
    characters: [{ id: "c1", name: "阿瑶", anchor: "白衣" }],
    motion: { referenceVideo: "dance.mp4", animateMode: "wan-std" },
  });
  const graph = compilePlan(plan, {
    imageModel: "m",
    imageSize: "1080x1920",
    videoModel: "v",
    videoResolution: "720p",
    generateAudio: false,
    withVideo: true,
    continuity: true,
  });
  assert.equal(graph.motion_bg, undefined);
  assert.equal(graph.motion_char.inputs.backdrop, undefined);
  assert.equal(graph.shot_1_video.inputs.mode, "wan-std");
  // 没参考视频文件名必须直接拒绝，不能编一个
  assert.throws(() =>
    parsePlan({ mode: "motion", title: "x", motion: { animateMode: "wan-pro" } })
  );
});

test("动作迁移：stills 只出图，图里没有视频节点", () => {
  const { plan } = parsePlan({
    title: "只出图",
    mode: "motion",
    style: "古风",
    characters: [{ id: "c1", name: "阿瑶", anchor: "浅蓝汉服" }],
    // 这一步不碰视频，连参考视频都不需要
    motion: { stage: "stills", characterRef: "face.jpg", scene: "云海仙山" },
  });
  const graph = compilePlan(plan, {
    imageModel: "m",
    imageSize: "1080x1920",
    videoModel: "v",
    videoResolution: "720p",
    generateAudio: false,
    withVideo: true,
    continuity: true,
  });
  // 没有 WanAnimate 节点：误点「开始生成」也只花两张图的钱
  assert.equal(graph.shot_1_video, undefined);
  assert.equal(graph.motion_ref, undefined);
  assert.ok(graph.motion_bg);
  assert.ok(graph.motion_char);
});

test("动作迁移：带 characterImage 就复用旧图，不重新定妆", () => {
  const { plan } = parsePlan({
    title: "接着跑",
    mode: "motion",
    style: "古风",
    characters: [{ id: "c1", name: "阿瑶", anchor: "浅蓝汉服" }],
    motion: {
      referenceVideo: "dance.mp4",
      characterImage: "output/storyforge/motion_char_00001_.png",
      stage: "full",
      animateMode: "wan-pro",
    },
  });
  const graph = compilePlan(plan, {
    imageModel: "m",
    imageSize: "1080x1920",
    videoModel: "v",
    videoResolution: "720p",
    generateAudio: false,
    withVideo: true,
    continuity: true,
  });
  assert.equal(graph.motion_char, undefined);
  assert.equal(graph.motion_bg, undefined);
  assert.equal(graph.motion_char_reuse.class_type, "LoadImage");
  // 路径被收敛成文件名，内核会在 input/ 与 output/ 里找
  assert.equal(graph.motion_char_reuse.inputs.image, "motion_char_00001_.png");
  assert.deepEqual(graph.shot_1_video.inputs.character, ["motion_char_reuse", 0]);
  // 复用图没有 URL 输出，character_url 必须不接，否则图审计会报类型错
  assert.equal(graph.shot_1_video.inputs.character_url, undefined);
});
