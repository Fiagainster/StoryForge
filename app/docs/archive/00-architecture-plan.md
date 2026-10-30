# 自主规划短剧 Agent —— 架构方案与实施计划 v1

> 目标：用户用自然语言描述需求，模型自己设计生产流程并把它做出来；没有节点图，没有连线，没有"先学 ComfyUI 再创作"。
> 本文档是探索阶段的第一版判断，关键决策点见第 9 节。

---

## 1. 先对齐一个判断

ComfyUI 的问题不在"节点"这个形式，而在于**它把流程设计权交给了人，而且把流程固化在了一张图上**：

| ComfyUI 的现状 | 后果 |
|---|---|
| 流程 = 一张有向图 | 换个题材就要重画，无法复用"意图" |
| 参数散落在节点里 | 想改"女主换成短发"要改十几个节点 |
| 没有项目/角色/镜头概念 | 跨镜头一致性全靠人肉记 prompt |
| 执行 = 一次性跑完 | 第 7 个镜头坏了，整条重跑 |
| 上手成本 = 学节点语义 | 创作者被挡在门外 |

所以真正要做的不是"更好的节点编辑器"，而是**把流程从图里拿出来，变成模型可以生成、人可以审查、系统可以重跑的东西**。

一句话架构判断：

> **流程不是画出来的，是写出来的（计划 + 脚本）；节点不是给人看的，是给执行器用的。**

---

## 2. 分层架构

```
┌──────────────────────────────────────────────────────────┐
│  L4 对话层   用户："拍个雨夜重逢，30 秒，冷调赛博感"        │
│              ← 计划草案 / 定妆候选 / 分镜预览 / 粗剪        │
├──────────────────────────────────────────────────────────┤
│  L3 规划层   Planner（模型 + plan mode）                   │
│              产出：Episode 计划 IR（YAML，可审可改可重跑）   │
│              产出：生产脚本（workflow script，可版本化）     │
├──────────────────────────────────────────────────────────┤
│  L2 领域层   短剧语义：Project / Character / Scene / Shot   │
│              shot_render、episode_render、cut_assemble      │
│              一致性策略：角色资产 + 参考图 + seed + 风格bible│
├──────────────────────────────────────────────────────────┤
│  L1 能力层   语义化工具（模型只填语义参数，不碰 graph）       │
│              comfy_run(template, params) / asset_* / job_*  │
│              模板库：t2i-portrait / i2v-first-frame / ...   │
├──────────────────────────────────────────────────────────┤
│  L0 执行层   Provider 可插拔：ComfyUI(本地/远程) / Mock / 云 │
│              提交、轮询、取产物、重试、缓存、记账            │
└──────────────────────────────────────────────────────────┘
```

关键点：**L1 以下是"死"的（确定性、可测试），L2 以上是"活"的（模型自主）。** 越往下越稳定，越往上越自由。这样既有自主性，又不会每次重跑都换一个世界。

---

## 3. 六个关键设计决策

### D1｜不 fork 任何一边，做独立插件包

- ComfyUI 只当**生成后端**（HTTP `/prompt` + `/history` + `/view` + `/api/jobs`），不碰它的前端。
- DeepSeek Harness 只当**Agent 运行时**（工具注册、会话、plan mode、workflow 引擎、subagent）。
- 我们自己的代码 = 两个插件包：`dsh-plugin-comfyui`（L1）、`dsh-plugin-shortdrama`（L2/L3 语义）。
- 理由：harness 明确标注 developer preview，会有破坏性变更；fork 立刻背债。插件化是它设计上的原生扩展方式（`ctx.tools.register` / `defineTool`）。

### D2｜模型不生成 graph，模型生成"意图"

模型看到的是：

```jsonc
{ "template": "i2v-first-frame",
  "params": { "prompt": "雨夜霓虹下的便利店门口，林晚回头", "first_frame": "asset://linwan/ref-01", "duration": 4, "seed": 88231 } }
```

而不是 40 个节点的 JSON。模板负责把语义参数编译成 graph。
- 好处：模型不会被节点 schema 淹没；模板可测试；换模型只改模板。
- 逃生舱：保留底层 `comfy_submit_graph`，模型遇到模板覆盖不到的情况可以自己拼图。

### D3｜计划是数据，不是 prompt

`episode.yaml` 是唯一事实源。它可 diff、可审查、可局部重跑、可跨会话续做。
这解决了 ComfyUI 最痛的点：**改一个镜头不用重来一遍。**

### D4｜一致性是一等公民，不是 prompt 技巧

角色 = 资产（参考图 + LoRA + 声音 + 外貌锚点文本），存在 `characters.yaml`。
每个镜头生成时自动注入角色资产，而不是让模型每次重新描述长相。
流程上强制"**先定妆、后拍戏**"：定妆照锁定后才允许生成该角色的镜头。

### D5｜流程可执行、可版本化

利用 harness 的 workflow 引擎：模型写一段 JS 编排脚本（`parallel` / `pipeline` / `agent()`），流程本身就是代码，可存进仓库、可 review、可重跑。
→ "自主规划"的产物不是一段消失的思考，而是一个**可以再看一遍、可以改一行再跑**的东西。

### D6｜人审在关键节点，不在每一步

只设 3 个检查点：计划批准 → 定妆选定 → 粗剪确认。
其余全自动。避免变成"每张图都要点确认"的伪自动化。

---

## 4. 领域模型（草案）

```
project/
  project.yaml            # 剧名/类型/画幅/风格bible/预算上限
  characters.yaml         # 角色资产与外貌锚点
  episodes/ep01/
    episode.yaml          # 场次与镜头（唯一事实源）
    script.md
  assets/
    characters/linwan/ref-01.png
    shots/ep01-s02-sh03/v001.png | v001.mp4
  runs/2026-10-28T18-30/  # 每次执行的快照：输入+产物+日志+成本
```

镜头（Shot）示例：

```yaml
id: ep01-s02-sh03
duration: 4.0
shot_size: medium-close
camera: slow push-in
prompt: 林晚站在雨夜便利店门口，霓虹在积水里反光，她抬头看向街角
negative: 多余手指, 文字水印, 畸变
characters: [linwan]
first_frame: ep01-s02-sh02@last_frame   # 承接上一镜，保证连贯
dialogue:
  - { speaker: linwan, text: "你终于来了。", emotion: 压抑, pause_after: 0.4 }
audio: { bgm: tension-low, sfx: [rain-heavy, door-bell] }
status: draft | approved | rendered | failed
```

`first_frame: 上一镜@last_frame` 是短剧连贯性的关键机制——镜头之间用"尾帧接首帧"，而不是各自凭空生成。

---

## 5. 能力层工具清单（L1）

| 工具 | 作用 | 关键点 |
|---|---|---|
| `comfy_status` | 后端健康、GPU、队列 | 开工前自检，失败给可读原因 |
| `comfy_models` | 可用模型 + 适配模板 | 让模型知道"现在能拍什么" |
| `comfy_run` | 按模板+参数提交，返回产物句柄 | 支持 wait/async、超时、取消 |
| `comfy_job` | 查询/取消任务 | 长任务用后台 job，不阻塞对话 |
| `comfy_submit_graph` | 原始 graph 逃生舱 | 模板覆盖不到时用 |
| `asset_put/get/list` | 内容寻址资产账本 | 同参数同 seed 命中缓存，省钱 |
| `plan_read/write` | 读写计划 IR，带 schema 校验 | 防模型写出结构错误的计划 |
| `shot_render` | 高层：一个镜头端到端 | 自动选模板、注入角色、承接首帧、落盘、记账 |
| `episode_render` | 批量渲染，并发+预算门限 | 超预算暂停问人 |
| `cut_assemble` | 拼接/字幕/音轨/转场 | ffmpeg，输出竖屏 9:16 |

模板（`templates/*.yaml`）格式：

```yaml
id: i2v-first-frame
backend: comfyui
graph: graphs/i2v-first-frame.json      # ComfyUI API 格式
bindings:
  prompt:      { node: "6",  input: "text" }
  first_frame: { node: "12", input: "image" }
  duration:    { node: "20", input: "length" }
  seed:        { node: "3",  input: "seed" }
outputs:
  video: { node: "30" }
limits: { duration: [2, 5], fps: [16, 24] }
```

---

## 6. 一次完整链路（对话视角）

```
用户：拍个雨夜重逢，30 秒，女主林晚，冷调赛博感

Agent：[读 project.yaml + characters.yaml]
      → 计划模式，产出 ep01 计划草案 + 成本估算（约 N 次生成）
用户：批准，但第 2 场改成便利店里面

Agent：[改计划] → 角色定妆：生成 3 张候选 → 用户选 1 张 → 锁定 ref-01
      → 逐镜：首帧图 → 图生视频 → 落盘（并发 2，超时重试 1 次）
      → 配音 + 字幕 + 拼接 → 粗剪预览
用户：第 3 镜太慢了，重做，节奏快一点

Agent：[只重跑 shot 3，feedback 注入 prompt，其余命中缓存]
      → 导出成片
```

这条链路里，用户只说了 3 句话，模型做了 30+ 次决策，但每一步都可查、可改、可重跑。

---

## 7. 里程碑

| 阶段 | 内容 | 验收标准 | 预估 |
|---|---|---|---|
| **M0 骨架** | harness 跑起来；插件包脚手架；`comfy_status` 在 UI 可见；Mock Provider 返回占位产物 | 对话里让 agent 调工具拿到后端信息 | 0.5–1 天 |
| **M1 能力层** | 模板引擎 + t2i / i2v / upscale 三个模板 + `comfy_run` + 资产账本 + 缓存 | 一条指令产出 1 张图 + 1 段 3 秒视频，路径可打开 | 1–2 天 |
| **M2 领域层** | Project/Episode schema + `shot_render` + 剧本/分镜 skill + 计划批准流 | 一句话 → 3 镜分镜图 + 视频草稿 | 2–3 天 |
| **M3 成片** | TTS + 字幕 + 拼接 + 转场 + BGM | 30 秒竖屏样片 mp4 | 1–2 天 |
| **M4 迭代** | 单镜重生成、A/B 对比、critic 自评、成本记账、跨集一致性 | 改一句反馈只重跑受影响镜头 | 持续 |

**首期建议只做 M0→M1，用 15–30 秒样片验证"对话能否驱动生产"这件事本身。**

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **角色一致性**（最大风险） | 每个镜头长得不一样，片子废掉 | 定妆照锁定 + 参考图注入 + 固定 seed + 风格 bible；先做"锁定"再做"生成" |
| **本机无独显**（Iris Xe / 16GB） | 本地跑不动视频模型 | Provider 可插拔；先 Mock 打通，真实生成接远程/云 GPU |
| **视频模型时长限制** | 单次只能 2–5 秒 | 短镜头拼接 + 尾帧接首帧 + 补帧 |
| **上游 API 不稳**（harness dev preview） | 升级即坏 | 独立插件包 + 锁定版本，不改上游源码 |
| **成本失控** | 反复重生成烧钱 | 内容寻址缓存 + 预算门限 + 批量前先估算 |
| **工具链缺失** | 本机无 ffmpeg | 装 ffmpeg 静态包；TTS 先用免费方案（如 edge-tts） |
| **模型自由发挥过头** | 计划结构错乱、跳过定妆 | schema 校验 + 检查点门禁 + 计划批准前置 |

---

## 9. 需要你决策的四件事

1. **生成后端放哪？** 本机无独显、models 目录为空，真实出片必须外接。
2. **首期验证目标？** 30 秒样片 / 完整单集 / 只要架构骨架。
3. **入口形态？** 直接用 harness 自带 Web UI / 自建前端 / 先 CLI。
4. **短剧类型与画幅？** 竖屏 9:16 都市情感，还是别的？这决定模板与镜头语法。

---

## 10. 下一步（等你确认后我立刻做）

1. 跑通 harness（`pnpm install && pnpm build && pnpm dsh web`），确认插件开发链路可用。
2. 建 `packages/dsh-plugin-comfyui` 骨架，注册 `comfy_status`，Mock 后端返回假产物。
3. 用一条真实对话验证：**"你能生成一张图吗"→ agent 自己选模板、调工具、拿到文件**。
4. 这一步跑通，整个架构就成立了，剩下是堆模板和领域语义。
