/**
 * 极简 CDP 客户端：attach 到 Tauri 的 WebView2，执行 JS / 截图。
 * 用法：
 *   node cdp.mjs eval "<表达式>"
 *   node cdp.mjs shot <输出文件>
 *   node cdp.mjs reload
 */
const PORT = process.env.CDP_PORT || "9222";

async function target() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("没有找到可用的 page target");
  return page;
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", (e) => rej(new Error("ws error " + e.message)));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { res, rej } = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      waiting.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ws, send, ready };
}

const [cmd, arg] = process.argv.slice(2);
const t = await target();
const { ws, send, ready } = connect(t.webSocketDebuggerUrl);
await ready;

const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

if (cmd === "eval") {
  const r = await send("Runtime.evaluate", {
    expression: arg,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails)
    console.log("EXCEPTION:", r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  else out(r.result.value);
} else if (cmd === "shot") {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const fs = await import("node:fs");
  fs.writeFileSync(arg, Buffer.from(r.data, "base64"));
  console.log("saved", arg);
} else if (cmd === "click") {
  const [x, y] = arg.split(",").map(Number);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  console.log("clicked", x, y);
} else if (cmd === "reload") {
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  console.log("reloaded");
}
ws.close();
