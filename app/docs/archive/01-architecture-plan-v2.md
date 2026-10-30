# 自主规划短剧 Agent —— 架构方案 v2（后端定为火山引擎）

> v1 假设用 ComfyUI 当执行后端；本版按你的决定改为**全部生成走火山引擎方舟 API**，并补上自建前端设计。
> 已确认：首期做 15–30 秒样片；前端自建。

---

## 0. 一个必须说清的事实

**ComfyUI 的源码在这个方案里基本用不上了。**

它不是不好，而是它解决的问题（把模型节点编排成图、在本机跑推理）被你选的路线绕过了：
- 你不用买卡、不用下模型权重、不用装 custom node；
- 火山把"图"封装成了两个 HTTP 接口（生图 / 生视频），一致性、尾帧、音画同步都做在模型里；
- 我们要做的"自主规划"发生在**接口之上**，而不是节点之间。

所以那两个仓库的定位调整为：
- `ComfyUI-master`：**参考物**。看它怎么表达"执行图/依赖/输出"，将来若要接本地开源模型，按同一套 Provider 接口加一个后端即可。不参与首期实现。
- `deepseek-harness`：**真正的地基**。Agent 循环、工具注册、会话持久化、计划模式、workflow 编排、Web 客户端插件，全部现成。

---

## 1. 核心判断（不变）

> 流程不是画出来的，是写出来的（计划 + 脚本）；节点不是给人看的，是给执行器用的。

ComfyUI 的死板来自"流程 = 一张人画的图"。我们要的是"流程 = 一份模型生成、人可审、系统可重跑的计划"。

---

## 2. 架构

```
┌─────────────────────────────────────────────────────────────┐
│ L4 对话 + 工作台（自建前端）                                  │
│    左：对话   右：分镜板 / 时间线 / 预览 / 成本                │
├─────────────────────────────────────────────────────────────┤
│ L3 规划层  Planner（模型 + plan mode）                        │
│    → Episode 计划 IR（YAML，可审可改）                        │
│    → 生产脚本（workflow script，可版本化、可重跑）             │
├─────────────────────────────────────────────────────────────┤
│ L2 领域层  短剧语义 + Prompt Compiler                        │
│    Project / Character / Scene / Shot                        │
│    shot_render / episode_render / cut_assemble               │
├─────────────────────────────────────────────────────────────┤
│ L1 能力层  ark_image / ark_video / ark_task / asset_*        │
│    语义参数 → 请求体；不暴露 token、URL 细节给模型            │
├─────────────────────────────────────────────────────────────┤
│ L0 执行层  Provider 可插拔                                    │
│    ArkProvider（火山，主）/ MockProvider（离线开发）          │
│    [预留] ComfyUIProvider / 其他云                            │
└─────────────────────────────────────────────────────────────┘
```

**L1 以下确定、可测；L2 以上自由、由模型决策。** 这是"自主"和"可靠"能同时成立的原因。

---

## 3. 火山引擎接口（已核实）

### 生图
```
POST https://ark.cn-beijing.volces.com/api/v3/images/generations
Authorization: Bearer $ARK_API_KEY
{
  "model": "doubao-seedream-5-0-pro-260628",
  "prompt": "...",
  "image": ["<参考图URL或base64>", ...],   // 最多 10–14 张，决定角色一致性
  "size": "2K",
  "output_format": "png",
  "watermark": false,
  "sequential_image_generation": "disabled" // 或 auto 出组图
}
→ { data: [{ url }], usage }
```
可用模型：`doubao-seedream-5-0-pro-260628` / `5-0-lite-260128` / `4-5-251128` / `4-0-250828`。

### 生视频（异步任务）
```
POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks
{
  "model": "doubao-seedance-2-5-260628",
  "content": [
    { "type": "text", "text": "..." },
    { "type": "image_url", "image_url": { "url": "..." }, "role": "reference_image" }
  ],
  "duration": 5,
  "ratio": "9:16",
  "resolution": "720p",
  "generate_audio": true,
  "return_last_frame": true,
  "seed": 88231,
  "watermark": false
}
→ { "id": "cgt-..." }

GET /api/v3/contents/generations/tasks/{id}
→ status: queued | running | succeeded | failed | expired
   content.video_url / content.last_frame_url
```
可用模型：`doubao-seedance-2-5-260628` / `2-0-260128` / `1-5-pro` / `1-0-pro-fast`。

### 三个能力直接决定短剧成败
| 能力 | 作用 |
|---|---|
| **多图参考（image 数组）** | 角色一致性——把定妆照当参考图喂进去，而不是靠文字描述长相 |
| **return_last_frame + 尾帧当首帧** | 镜头接续——上一镜的尾帧就是下一镜的首帧，动作和光线不断裂 |
| **generate_audio** | 一次生成画面 + 人声/音效/环境声，省掉独立 TTS 对齐的麻烦 |
| **sequential_image_generation** | 一次出整组分镜，风格天然统一，还省调用 |

> 注意：`/api/plan/v3` 是 Agent Plan 专属通道，普通按量 Key 必须用 `/api/v3`。两者不能混，否则报错或多扣费。

---

## 4. 六个设计决策

### D1｜不 fork，不魔改：harness 当运行时，火山当执行器
我们只写两个插件包：
- `dsh-plugin-ark`：Provider + 三个工具（生图/生视频/查任务）
- `dsh-plugin-shortdrama`：领域模型 + Prompt Compiler + 高层工具

### D2｜模型不拼请求体，模型填语义
模型看到的是 `shot_render(shot_id)` 和 `ark_image(prompt, refs, size)`，看不到 token、URL、轮询逻辑。
好处：模型不会被接口字段淹没；换后端只改 Provider。

### D3｜Prompt Compiler 是一等公民（v2 新增，最关键）
短剧一致性不能靠模型每次"重新描述女主长相"。做法：
```
最终 prompt = 风格前缀（style bible）
            + 角色锚点（characters.yaml 里的固定描述 + 参考图）
            + 镜头语言（景别/运镜/光线）
            + 动作与台词
            + 负向约束（畸变/多余肢体/文字水印）
```
编译器是纯函数、可单测、可 diff。**同一角色在任何镜头里的描述永远逐字一致**——这是 ComfyUI 时代靠人肉复制 prompt 做不到的。

### D4｜计划是数据
`episode.yaml` 是唯一事实源：可 diff、可审查、可只重跑第 3 镜、可跨会话续做。

### D5｜流程可执行、可版本化
模型用 harness 的 workflow 引擎写一段 JS 编排脚本（`parallel` / `pipeline`），脚本进仓库。
"自主规划"的产物不是一段消失的思考，而是**改一行就能重跑的东西**。

### D6｜人只审三个点
计划批准 → 定妆选定 → 粗剪确认。其余全自动。

---

## 5. 领域模型

```
project/
  project.yaml          # 剧名/画幅/风格bible/预算上限/模型选型
  characters.yaml       # 角色：外貌锚点、参考图、声音
  episodes/ep01/
    episode.yaml        # 场次 + 镜头（唯一事实源）
    script.md
  assets/
    characters/linwan/ref-01.png
    shots/ep01-s02-sh03/v001.png | v001.mp4
  runs/<ts>/            # 每次执行快照：输入+产物+日志+token 用量
```

```yaml
# episode.yaml 片段
shots:
  - id: ep01-s02-sh03
    duration: 5
    shot_size: medium-close
    camera: slow push-in
    action: 林晚站在雨夜便利店门口，霓虹在积水里反光，她抬头看向街角
    negative: 多余手指, 文字水印, 面部畸变
    characters: [linwan]
    continuity: { first_frame_from: ep01-s02-sh02, mode: last_frame }
    dialogue:
      - { speaker: linwan, text: "你终于来了。", emotion: 压抑 }
    audio: { bgm: tension-low, sfx: [rain-heavy, door-bell] }
    status: draft        # draft|approved|rendering|rendered|failed
```

---

## 6. 工具清单

| 工具 | 作用 |
|---|---|
| `ark_status` | Key 有效性、可用模型、余额/限流自检 |
| `ark_image` | 生图：prompt + 参考图 + 尺寸 → 落盘资产 |
| `ark_video` | 生视频：提交任务 → 返回 task_id（不阻塞） |
| `ark_task` | 查/取消任务，成功则下载视频与尾帧 |
| `asset_put/get/list` | 内容寻址资产账本（同参命中缓存，省钱） |
| `prompt_compile` | Shot + Character + Style → 最终 prompt（可单独调用做调试） |
| `plan_read/write` | 计划 IR 读写 + schema 校验 |
| `shot_render` | 一个镜头端到端：编译→生图→生视频→落盘→记账 |
| `episode_render` | 批量渲染，并发上限 + 预算门限 |
| `cut_assemble` | ffmpeg：拼接、字幕、音轨、转场、导出 9:16 |

---

## 7. 自建前端设计

不自研对话内核，**在 harness 的 Web 客户端插件体系里做工作台**（它本来就是插件化的，有 slot / renderer / ConversationNode 机制）。这样省掉 3 天对话流 + 流式渲染的重复劳动，把时间花在短剧特有界面上。

```
┌──────────────┬──────────────────────────────────────┐
│              │  分镜板（grid）                       │
│   对话        │  ┌────┐┌────┐┌────┐┌────┐            │
│  （复用）     │  │ 01 ││ 02 ││ 03 ││ 04 │  状态/重做  │
│              │  └────┘└────┘└────┘└────┘            │
│              ├──────────────────────────────────────┤
│              │  时间线：镜头块 + 时长 + 音轨          │
│              ├──────────────────────────────────────┤
│              │  预览播放器 + 成本条（token/调用次数）  │
└──────────────┴──────────────────────────────────────┘
```

关键交互：
- 点某个镜头 → "重做这个"、"换更快的节奏"、"这个角色不像" → 直接变成一句对话发给 agent
- 分镜板状态由我们自己的 `drama/*` 事件投影驱动（参考 harness 的 `ui-workflow-run` 做法）

---

## 8. 里程碑

| 阶段 | 内容 | 验收 | 预估 |
|---|---|---|---|
| **M0** | harness 跑起来；`dsh-plugin-ark` 骨架；`ark_status` 打通真实 Key | 对话里问"后端能用吗"，agent 调工具答出可用模型 | 0.5 天 |
| **M1** | `ark_image` + 资产账本 + Prompt Compiler v0 | 一句话生成一张竖屏角色图，落盘可打开 | 1 天 |
| **M2** | `ark_video` + 任务轮询 + 尾帧接续 | 图生 5 秒视频，尾帧接到下一镜 | 1 天 |
| **M3** | 领域模型 + `shot_render` + 计划批准流 + 剧本/分镜 skill | 一句话 → 3 镜分镜图 + 视频 | 2 天 |
| **M4** | 工作台前端（分镜板 + 时间线 + 预览） | 能在界面上点选、重做、看进度 | 2–3 天 |
| **M5** | 合成：字幕、拼接、音轨、导出 | 30 秒竖屏样片 mp4 | 1 天 |

**首期到 M5，约 1–1.5 周**（不含调试波动）。M0–M2 跑通就能判断这条路成不成立。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| **角色一致性**（头号风险） | 定妆照锁定 + 多图参考 + Prompt Compiler 逐字复用 + 固定 seed；先"定妆"再"拍戏" |
| **单条视频时长有限**（5/10/15 秒） | 按镜头切分，尾帧接首帧；长镜头用"延长"能力或补帧 |
| **成本与限流** | 内容寻址缓存 + 批量前估算 + 并发上限 + 失败不重试超过 1 次 |
| **生成不可控（人物手部/文字）** | 负向约束 + 候选多张择优 + 单镜重做而不是整片重来 |
| **harness 是 developer preview** | 独立插件包 + 锁版本，不改上游源码 |
| **本机缺 ffmpeg** | 装静态包（我来装） |
| **API 通道用错**（/api/v3 vs /api/plan/v3） | 配置里显式区分，启动自检打印 base url |

---

## 10. 现在需要你给的两样东西

1. **`ARK_API_KEY`**（放到项目 `.env`，我会加进 `.gitignore`）。
   同时确认：是**普通按量 Key**（base url `/api/v3`）还是 **Agent Plan 专属 Key**（`/api/plan/v3`）？
2. **模型权限**：账号开通了哪些？建议先用 `doubao-seedream-5-0-pro`（图）+ `doubao-seedance-2-5`（视频，支持 15 秒 + 同步音频 + 尾帧）。

拿到这两样，我按 M0→M1 直接开工。
