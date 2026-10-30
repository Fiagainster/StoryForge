import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGraphOps } from "./graphOps.js";
import type { ComfyGraph } from "../types";

const CARDS: Record<string, { display: string; in: { k: string; t: string; def?: unknown }[]; out: string[] }> = {
  EmptyImage: {
    display: "空图",
    in: [
      { k: "width", t: "INT", def: 512 },
      { k: "height", t: "INT", def: 512 },
    ],
    out: ["IMAGE"],
  },
  SaveImage: {
    display: "存图",
    in: [{ k: "images", t: "IMAGE" }],
    out: [],
  },
};

const ctx = { cardOf: (ct: string) => CARDS[ct] };

test("add：补默认值、拒绝连线混进 inputs、拒绝重复 id", () => {
  const { graph, applied, errors } = applyGraphOps(
    {},
    [
      { op: "add", class_type: "EmptyImage", id: "1", inputs: { width: 720 } },
      { op: "add", class_type: "EmptyImage", id: "1" },
      { op: "add", class_type: "EmptyImage", id: "2", inputs: { width: [1, 0] } },
      { op: "add", class_type: "Nope" },
    ],
    ctx
  );
  assert.equal(graph["1"].inputs.width, 720);
  assert.equal(graph["1"].inputs.height, 512); // 默认值补上
  assert.equal(applied.length, 1);
  assert.equal(errors.length, 3);
});

test("connect：类型必须匹配，越界/缺输入都报错", () => {
  const base: ComfyGraph = {
    "1": { class_type: "EmptyImage", inputs: {}, _meta: { title: "空图" } },
    "2": { class_type: "SaveImage", inputs: { images: [null as any, 0] }, _meta: { title: "存图" } },
  };
  const { graph, applied, errors } = applyGraphOps(
    base,
    [
      { op: "connect", id: "2", key: "images", from: ["1", 0] },
      { op: "connect", id: "2", key: "nope", from: ["1", 0] },
      { op: "connect", id: "2", key: "images", from: ["9", 0] },
    ],
    ctx
  );
  assert.deepEqual(graph["2"].inputs.images, ["1", 0]);
  assert.equal(applied.length, 1);
  assert.equal(errors.length, 2);
});

test("set：只接受标量、未知参数拒绝", () => {
  const base: ComfyGraph = { "1": { class_type: "EmptyImage", inputs: {}, _meta: { title: "" } } };
  const { graph, applied, errors } = applyGraphOps(
    base,
    [
      { op: "set", id: "1", key: "width", value: 1080 },
      { op: "set", id: "1", key: "width", value: [1, 0] },
      { op: "set", id: "1", key: "nope", value: 1 },
    ],
    ctx
  );
  assert.equal(graph["1"].inputs.width, 1080);
  assert.equal(applied.length, 1);
  assert.equal(errors.length, 2);
});

test("remove：连带清掉指向它的连线", () => {
  const base: ComfyGraph = {
    "1": { class_type: "EmptyImage", inputs: {}, _meta: { title: "" } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0] }, _meta: { title: "" } },
  };
  const { graph } = applyGraphOps(base, [{ op: "remove", id: "1" }], ctx);
  assert.equal(graph["1"], undefined);
  assert.equal(graph["2"].inputs.images, undefined);
});

test("setMeta：改显示名并截到 40 字", () => {
  const base: ComfyGraph = { "1": { class_type: "EmptyImage", inputs: {}, _meta: { title: "" } } };
  const { graph } = applyGraphOps(base, [{ op: "setMeta", id: "1", title: "x".repeat(60) }], ctx);
  assert.equal(graph["1"]._meta!.title!.length, 40);
});
