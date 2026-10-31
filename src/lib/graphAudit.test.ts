import { test } from "node:test";
import assert from "node:assert/strict";
import { auditGraph, diffGraph, diffSummary } from "./graphAudit.js";
import type { ComfyGraph } from "../types";
import type { LibInput } from "./nodeSearch";

/**
 * 注入假节点卡：不依赖 447KB 的节点库，单测纯逻辑。
 * 注意：终点类名要用真实的 SaveImage——auditGraph 的"没有终点"判断不看注入卡。
 */
const CARDS: Record<string, { d: string; in: LibInput[]; out: string[] }> = {
  Source: {
    d: "来源",
    in: [
      { k: "text", t: "STRING", req: 1 },
      { k: "url_in", t: "STRING", req: 0 },
    ],
    out: [],
  },
  SaveImage: { d: "存图", in: [{ k: "images", t: "IMAGE", req: 1 }], out: [] },
  Gen: {
    d: "生成",
    in: [
      { k: "model", t: "STRING", req: 1 },
      { k: "image", t: "IMAGE", req: 0 },
    ],
    out: ["IMAGE", "STRING"],
  },
};
const L = { cardOf: (ct: string) => CARDS[ct], blockedOf: () => undefined };

test("auditGraph：URL 填进普通 STRING 字段 → 警告；url 字段不警告", () => {
  const g: ComfyGraph = {
    "1": {
      class_type: "Source",
      inputs: {
        text: "https://ark.example.com/xxx.png",
        url_in: "https://ok.example.com/a.png",
      },
      _meta: { title: "来源" },
    },
    "2": {
      class_type: "SaveImage",
      inputs: { images: ["1", 0] },
      _meta: { title: "存" },
    },
  };
  const issues = auditGraph(g, L);
  const warns = issues.filter((i) => i.level === "warn");
  assert.equal(warns.length, 1);
  assert.ok(warns[0].text.includes('"text"'));
  assert.ok(warns[0].text.includes("网址"));
  assert.equal(issues.filter((i) => i.level === "error").length, 0);
});

test("auditGraph：空图 / 没终点 / 孤岛", () => {
  assert.equal(auditGraph({}, L)[0].level, "error");

  const noSink: ComfyGraph = {
    "1": { class_type: "Source", inputs: { text: "hi" }, _meta: { title: "" } },
  };
  const a = auditGraph(noSink, L);
  assert.ok(a.some((i) => i.text.includes("没有保存节点")));

  const island: ComfyGraph = {
    "1": { class_type: "Source", inputs: { text: "hi" }, _meta: { title: "" } },
    "2": { class_type: "Gen", inputs: { model: "m" }, _meta: { title: "" } },
    "3": { class_type: "SaveImage", inputs: { images: ["2", 0] }, _meta: { title: "" } },
  };
  const b = auditGraph(island, L);
  assert.ok(b.some((i) => i.level === "warn" && i.text.includes("没接到产物上")));
});

test("auditGraph：标量输入接了线 → 警告", () => {
  const g: ComfyGraph = {
    "1": { class_type: "Source", inputs: { text: "hi" }, _meta: { title: "" } },
    "2": {
      class_type: "Gen",
      inputs: { model: ["1", 0] },
      _meta: { title: "" },
    },
    "3": { class_type: "SaveImage", inputs: { images: ["2", 0] }, _meta: { title: "" } },
  };
  const issues = auditGraph(g, L);
  assert.ok(issues.some((i) => i.level === "warn" && i.text.includes("接了一根线")));
});

test("auditGraph：必填缺失 / 指向已删除节点 → error 并指向节点", () => {
  const g: ComfyGraph = {
    "1": { class_type: "Source", inputs: {}, _meta: { title: "" } },
    "2": { class_type: "SaveImage", inputs: { images: ["99", 0] }, _meta: { title: "" } },
  };
  const errs = auditGraph(g, L).filter((i) => i.level === "error");
  assert.equal(errs.length, 2);
  const missing = errs.find((i) => i.id === "1");
  assert.ok(missing && missing.text.includes('"text"'));
  const dangling = errs.find((i) => i.id === "2");
  assert.ok(dangling && dangling.text.includes("99"));
});

test("diffGraph：增删改与连线差值", () => {
  const before: ComfyGraph = {
    "1": { class_type: "Source", inputs: { text: "a" }, _meta: { title: "甲" } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0] }, _meta: { title: "乙" } },
  };
  const after: ComfyGraph = {
    "1": { class_type: "Source", inputs: { text: "b" }, _meta: { title: "甲" } },
    "3": { class_type: "Gen", inputs: { model: "m" }, _meta: { title: "丙" } },
    "2": { class_type: "SaveImage", inputs: { images: ["3", 0] }, _meta: { title: "乙" } },
  };
  const d = diffGraph(before, after);
  assert.deepEqual(d.added.map((x) => x.id), ["3"]);
  assert.deepEqual(d.removed.map((x) => x.id), []);
  assert.deepEqual(d.changed.map((x) => x.id), ["1", "2"]);
  assert.equal(d.linksAdded, 1);
  assert.equal(d.linksRemoved, 1);
  assert.ok(diffSummary(d).includes("+1 节点"));
});
