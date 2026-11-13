import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactFromEvent, artifactsFromRunFiles } from "./runArtifacts.js";

test("画布产物：只认 _run 子目录", () => {
  const map = artifactsFromRunFiles([
    { filename: "shot_1.png", subfolder: "_run" },
    { filename: "shot_1_00001_.png", subfolder: "storyforge/film" },
    { filename: "character.png", subfolder: "" },
  ]);
  assert.deepEqual(Object.keys(map), ["shot_1"]);
  assert.equal(map["shot_1"].kind, "image");
  assert.equal(map["shot_1"].subfolder, "_run");
});

test("画布产物：同一节点图与视频并存时视频优先", () => {
  const map = artifactsFromRunFiles([
    { filename: "shot_1.mp4", subfolder: "_run" },
    { filename: "shot_1.png", subfolder: "_run" },
  ]);
  assert.equal(map["shot_1"].kind, "video", "视频是这条链走到最后的那一步");
  assert.equal(map["shot_1"].filename, "shot_1.mp4");

  // 反过来顺序无关：先图后视频同样归视频
  const map2 = artifactsFromRunFiles([
    { filename: "shot_1.png", subfolder: "_run" },
    { filename: "shot_1.mp4", subfolder: "_run" },
  ]);
  assert.equal(map2["shot_1"].kind, "video");
});

test("画布产物：非媒体文件与非 _run 的脏数据都不进画布", () => {
  const map = artifactsFromRunFiles([
    { filename: "cache.json", subfolder: "_run" },
    { filename: "notes.txt", subfolder: "_run" },
    { filename: "shot_1.png", subfolder: "storyforge" },
    { filename: "shot_1.jpeg", subfolder: "_run" },
  ]);
  assert.deepEqual(Object.keys(map), ["shot_1"]);
  assert.equal(map["shot_1"].kind, "image");
});

test("画布产物：扫描结果叠在已有映射上，不清空内存里更新的那份", () => {
  const base = { live: { filename: "live.png", subfolder: "_run", kind: "image" as const } };
  const map = artifactsFromRunFiles([{ filename: "other.png", subfolder: "_run" }], base);
  assert.ok(map.live, "已有记录必须保留");
  assert.ok(map.other);
});

test("画布产物：事件坐标缺 filename 时返回 null，不把节点误标成有产物", () => {
  assert.equal(artifactFromEvent(null), null);
  assert.equal(artifactFromEvent(undefined), null);
  assert.equal(artifactFromEvent({}), null);
  assert.equal(artifactFromEvent({ filename: "" }), null);
});

test("画布产物：事件坐标缺 subfolder/kind 时补默认值", () => {
  assert.deepEqual(artifactFromEvent({ filename: "shot_1.mp4" }), {
    filename: "shot_1.mp4",
    subfolder: "_run",
    kind: "image",
  });
  assert.deepEqual(artifactFromEvent({ filename: "shot_1.mp4", kind: "video" }), {
    filename: "shot_1.mp4",
    subfolder: "_run",
    kind: "video",
  });
});
