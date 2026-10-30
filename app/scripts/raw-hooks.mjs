/**
 * ESM 加载钩子：让 node 能吃 vite 的 `?raw` 导入（node-library.json?raw）。
 * 用法：node --import ./scripts/register-raw.mjs --test .test-build/
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  const i = specifier.lastIndexOf("?raw");
  if (i !== -1) {
    const resolved = await next(specifier.slice(0, i), context);
    return { url: resolved.url + "?raw", shortCircuit: true };
  }
  try {
    return await next(specifier, context);
  } catch (e) {
    // tsc 发射的 ESM 保留无扩展名导入，node 不认：补 .js 再试一次
    const rel = specifier.startsWith("./") || specifier.startsWith("../");
    if (
      (e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "ERR_UNSUPPORTED_DIR_IMPORT") &&
      rel &&
      !/\.(js|mjs|json|ts)$/.test(specifier)
    ) {
      return await next(specifier + ".js", context);
    }
    throw e;
  }
}

export async function load(url, context, next) {
  const i = url.indexOf("?raw");
  if (i === -1) return next(url, context);
  const file = fileURLToPath(url.slice(0, i));
  const text = readFileSync(file, "utf8");
  return {
    format: "module",
    source: "export default " + JSON.stringify(text),
    shortCircuit: true,
  };
}
