# StoryForge 优化计划 · 参考 OpenMontage

> 对标对象：OpenMontage（agent-first 视频生产框架，500 commits，GitHub Trending 日榜第一）
> 原则：**铆钉定位不动**——我们是"短剧分镜工作台"，不做全流程视频框架。
> OpenMontage 的优势按"短剧导演台"视角过滤：只抄能让我们这一件事做得更好的。

## 定位声明（先钉死）

**做**：一句话 → 分镜计划 → 画布人机共编 → 逐镜生成（ARK）→ 逐镜质检 → 拼接成片。
**不做**：网络调研写稿、真实素材检索、Remotion 时间轴剪辑、12 条通用流水线。

| | OpenMontage | StoryForge |
|---|---|---|
| 形态 | 编程助手 + 终端的编排框架 | 双击即用的桌面 GUI |
| 人在哪 | 审批门点头 | 画布上共编 |
| 深度 vs 广度 | 12 条流水线的广度 | 单镜重跑/多版对比/逐镜耗时的深度 |

我们的护城河是**交互深度**，他们的护城河是**链路广度**。计划目标：把广度短板中"每镜质量"和"钱"两块补到不输，广度摊子不接。

---

## P0-1 逐镜产物自审 + 自动重跑

**学自**：`skills/meta/reviewer.md`（渲染后自审协议）+ `render_report.schema.json`（ffprobe 验证契约）

**痛点**：ARK 返回"成功"但内容崩坏（黑屏/花屏/时长对不上），我们目前完全检测不到，用户点开才发现，还得多花一次重跑的钱。

**做法**（全部用已有 ffmpeg，无新依赖）：
- kernel 每个产物落盘后自检：
  - 视频：ffprobe 实测时长 vs 计划时长（容差 ±1.5s）、分辨率匹配、`generate_audio=true` 时必须有音轨
  - 图片：尺寸 vs size 参数、抽 3 帧（首/中/尾）算平均亮度，全黑/全白判废
  - 自检结果写进 run 记录（对齐 render_report：resolution/duration/fps/size/verification_notes）
- 不合格 → 自动重跑该镜（复用现有单镜重跑链路），原因喂进经验记忆
- **2 轮上限**（学 reviewer 协议：revise 最多 2 轮，仍失败 → pass with warnings，不无限烧钱）

**验收**：构造黑屏视频过自审 → 自动重跑 → 记录可见。
**工作量**：Rust 侧 ~1 天。

## P0-2 成本估算确认门 + 预算治理（简化版）

**学自**：`tools/cost_tracker.py`（estimate→reserve→reconcile 状态机）+ `tools/video/seedance_ark.py`（现成的 ARK 官方价格表，CNY/百万 token，2026-07-26 价）

**痛点**：确认门只显示镜头数和秒数，"这单花多少钱"全靠猜——README 能力边界里"成本换算成金额"一直是未通项。

**做法**：
- ARK 价格表写进 Rust 常量（Seedance 按分辨率/带不带视频参考、Seedream 按张）——OpenMontage 已整理好，直接抄
- `compilePlan` 后估算：镜头数 × 单价 × **1.3 重试缓冲**（学它），给区间 [低, 高]
- 确认卡显示"预计 ¥X.XX（区间 ¥A–B）"
- 配置加两项：`单次金额上限` + 模式（observe=只显示 / warn=超限提示 / cap=超限拦截）——不搬全套治理，状态机简化成"估算 → 执行 → 对账"三步
- run 记录对账实际花费，资产页用量统计加"¥"列

**验收**：3 镜 720p 计划确认门显示估算区间，cap 模式下超限被拦。
**工作量**：Rust + 前端 ~1.5 天。

## P1-1 分镜风险评分（slideshow_risk 移植）

**学自**：`lib/slideshow_risk.py`（6 维纯启发式评分，纯函数可单测）

**痛点**：审计只查结构（连线/类型），查不出"这版计划拍出来会很平"——景别全是中景、运镜全是固定、动作描述雷同。

**做法**：Rust 移植成 `planRisk(plan)` 纯函数，适配短剧语义：
- 景别重复率（>60% 同景别 → 扣分）
- 运镜多样性（全固定 → 扣分）
- 动作描述相似度（前 50 字去重率）
- 时长分布（全 5s → 扣分）
- 台词分布（集中在一镜 → 提示）
评分 → 确认门显示"分镜风险：strong / acceptable / revise"，revise 时附具体建议（"第 2、3 镜都是中景固定，建议第 3 镜改近景"）喂给出计划的提示词。
**工作量**：纯函数 + 单测 ~1 天。

## P1-2 Provider trait + 第二供应商

**学自**：`tools/base_tool.py`（capability/routes/_MODELS 元数据）+ `tools/provider_routing.py`（按输入能力过滤候选）

**痛点**：锁死 ARK——审核策略一变（首帧真人拦截就是前车之鉴）或涨价，我们断粮。

**做法**：
- kernel.rs 的 ARK 调用抽成 `Provider` trait：`capabilities()`（支持首帧/尾帧/参考图/音频）+ `estimate_cost()` + `generate_image/generate_video`
- 节点按输入能力过滤候选 Provider（学 routing 的 filter 思路）
- 第二家接**即梦**（OpenMontage 有现成 `jimeng_video.py` 可参考 API 形态），配置里 `video.provider` 选择
**工作量**：抽象 ~1 天，第二家 ~2 天。

## P1-3 双方案提案（proposal 模式）

**学自**：cinematic 流水线的 proposal 阶段（2-3 个差异化方案 + 成本估算 + 样片）

**痛点**：现在一次只出一个计划，用户只能"要或不要"，没有导演的选择感。

**做法**：出计划时让 LLM 一次给 2 个变体（不同情绪弧线/节奏），确认门左右并排选一个（含各自的风险分和成本估算）。LLM tokens 翻倍但分镜生成成本不变。
**工作量**：agent 提示词 + 确认卡 UI ~1.5 天。

## P2（后置，不承诺时间）

| 项 | 学自 | 说明 |
|---|---|---|
| 决策日志 | checkpoint 协议 | 每步"为什么这么改"沉淀进项目（run 记录已有雏形，补 decision 理由字段） |
| 审查发现带修复建议 | CHAI 规则 | 修复循环的 error 必须附 proposed_fix，不许只报"不行" |
| 配音 + 字幕烧录 | 12 条流水线公共能力 | **需要修订"不做字幕"的定位边界**，单独立项讨论；ARK 有 TTS，技术可行 |
| 多平台导出预设 | publish 阶段 | 9:16/16:9 一键变体（ffmpeg 裁切即可） |

## 不抄清单（明确的）

- **流水线框架化**：YAML manifest + 阶段技能 + 编排器——我们是固化产品不是框架
- **真实素材语料**（Archive.org/NASA/CLIP 检索）——偏离剧本短剧
- **Remotion/HyperFrames 渲染**——推翻"不做时间轴"的边界，成本不可控
- **Backlot 看板**——我们的分镜页实时镜像已覆盖同等能力

## 排期建议

P0-1 → P0-2 →（真跑验证）→ P1-1 → P1-3 → P1-2 → P2 按需。
P0 两项合计约 2.5 天工作量，落地后：钱看得见、坏镜自动重跑——这是对用户最直接的两刀。
