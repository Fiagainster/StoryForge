/** 测试构建后把 ?raw 引用的 JSON 同步进 .test-build（tsc 不会拷它） */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "src", "lib", "node-library.json");
const dest = join(root, ".test-build", "lib", "node-library.json");
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log("synced", dest);
