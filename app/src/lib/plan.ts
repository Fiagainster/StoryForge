import type {
  CameraMove,
  ComfyGraph,
  DramaCharacter,
  DramaPlan,
  DramaShot,
  ShotSize,
} from "../types";

export const SHOT_SIZES: ShotSize[] = [
  "大远景",
  "远景",
  "全景",
  "中景",
  "中近景",
  "近景",
  "特写",
  "大特写",
];

export const CAMERA_MOVES: CameraMove[] = [
  "固定",
  "缓慢推近",
  "缓慢拉远",
  "横移",
  "跟拍",
  "手持",
  "环绕",
  "俯拍",
  "仰拍",
];

const MAX_CHARACTERS = 4;
const MAX_SHOTS = 6;
const MAX_SHOT_SECONDS = 15;

export interface ParsedPlan {
  plan: DramaPlan;
  warnings: string[];
}

const text = (v: unknown, max = 400): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * 把模型返回的计划收敛成可执行的强类型计划。
 * 模型可以写得不规范，但编译器不接受脏数据。
 */
export function parsePlan(raw: unknown): ParsedPlan {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("计划不是一个对象");
  }
  const obj = raw as Record<string, unknown>;

  const mode: DramaPlan["mode"] = obj.mode === "image" ? "image" : "video";
  const title = text(obj.title, 40) || "未命名短剧";
  const style = text(obj.style, 500);

  const rawChars = Array.isArray(obj.characters) ? obj.characters.slice(0, MAX_CHARACTERS) : [];
  const characters: DramaCharacter[] = [];
  const refMap = new Map<string, string>();

  rawChars.forEach((item, index) => {
    const c = (item || {}) as Record<string, unknown>;
    const name = text(c.name, 20);
    const anchor = text(c.anchor, 300);
    if (!name || !anchor) {
      warnings.push(`第 ${index + 1} 个角色缺少名字或锚点，已忽略`);
      return;
    }
    const id = `c${characters.length + 1}`;
    characters.push({ id, name, anchor });
    const rawId = text(c.id, 20);
    if (rawId) refMap.set(rawId, id);
    refMap.set(name, id);
  });

  const rawShots = Array.isArray(obj.shots) ? obj.shots.slice(0, MAX_SHOTS) : [];
  if (!rawShots.length) throw new Error("计划里没有镜头");

  const shots: DramaShot[] = rawShots.map((item, index) => {
    const s = (item || {}) as Record<string, unknown>;
    const refs = Array.isArray(s.characters) ? s.characters : [];
    const cast: string[] = [];
    for (const ref of refs) {
      const id = refMap.get(String(ref));
      if (id && !cast.includes(id)) cast.push(id);
      else warnings.push(`镜头 ${index + 1} 引用了未定义角色「${String(ref)}」，已忽略`);
    }
    const shotSize = SHOT_SIZES.includes(s.shotSize as ShotSize)
      ? (s.shotSize as ShotSize)
      : "中景";
    if (shotSize !== s.shotSize) warnings.push(`镜头 ${index + 1} 景别不合法，回退到中景`);
    const camera = CAMERA_MOVES.includes(s.camera as CameraMove)
      ? (s.camera as CameraMove)
      : "固定";
    if (camera !== s.camera) warnings.push(`镜头 ${index + 1} 运镜不合法，回退到固定`);

    const rawDuration = Number(s.duration);
    const duration = Number.isFinite(rawDuration)
      ? clamp(Math.round(rawDuration), 4, MAX_SHOT_SECONDS)
      : 5;

    // 有台词的镜头必须配音：generateAudio=false 会把台词无声丢掉
    const dialogue = text(s.dialogue, 120);
    const generateAudio = dialogue ? true : s.generateAudio !== false;
    if (dialogue && s.generateAudio === false) {
      warnings.push(`镜头 ${index + 1} 有台词但关闭了配音，已自动打开`);
    }

    return {
      title: text(s.title, 40) || `镜头 ${index + 1}`,
      characters: cast.slice(0, 3),
      location: text(s.location, 160) || "未指定场景",
      action: text(s.action, 400) || "人物自然行动",
      emotion: text(s.emotion, 80),
      dialogue,
      shotSize,
      camera,
      duration,
      generateAudio,
    };
  });

  return {
    plan: { title, mode, style, characters, shots },
    warnings,
  };
}

export interface CompileOptions {
  imageModel: string;
  imageSize: string;
  videoModel: string;
  videoResolution: string;
  generateAudio: boolean;
  withVideo: boolean;
  /** 多镜时把上一镜尾帧接给下一镜首帧当衔接参考（仅视频模式） */
  continuity?: boolean;
  /**
   * 增量追加：新镜头从第几号开始编（默认 1）。
   * 编号必须和画布上已有的 shot_N_ 节点错开，追加分镜时传 maxShotOf(旧图)+1。
   */
  startShot?: number;
  /** 增量追加：新第一镜的 previous_frame 接到旧图这个节点上（旧末镜的尾帧） */
  prevTail?: string;
  /** 增量追加：按角色名复用旧图里已有的定妆节点（name → nodeId），不再重复生成 */
  reuseChars?: Map<string, string>;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 图里最大的分镜编号：增量追加时决定新镜从几号开始 */
export function maxShotOf(graph: ComfyGraph): number {
  let max = 0;
  for (const id of Object.keys(graph || {})) {
    const m = /^shot_(\d+)_/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * 计划 → ComfyUI API 图。连线由编译器保证，不交给模型即兴发挥。
 */
export function compilePlan(plan: DramaPlan, opts: CompileOptions): ComfyGraph {
  const graph: ComfyGraph = {};
  const used = new Set(plan.shots.flatMap((s) => s.characters));
  const charNodes = new Map<string, string>();
  const start = opts.startShot ?? 1;

  for (const c of plan.characters) {
    if (!used.has(c.id)) continue;
    // 追加模式：同名角色直接复用旧图里的定妆节点，不重复生成
    const reused = opts.reuseChars?.get(c.name);
    if (reused) {
      charNodes.set(c.id, reused);
      continue;
    }
    // 追加模式下新角色的 id 可能撞上旧图（旧图也有 char_c1），加个后缀错开
    const nodeId = opts.reuseChars ? `char_${c.id}_n${start}` : `char_${c.id}`;
    graph[nodeId] = {
      class_type: "DramaCharacter",
      inputs: {
        name: c.name,
        anchor: c.anchor,
        style: plan.style,
        model: opts.imageModel,
        framing: "半身",
        size: opts.imageSize,
        watermark: false,
      },
      _meta: { title: `定妆 · ${c.name}` },
    };
    charNodes.set(c.id, nodeId);
  }

  plan.shots.forEach((shot, index) => {
    const n = start + index;
    const frameId = `shot_${n}_frame`;
    const castAnchor = shot.characters
      .map((id) => {
        const c = plan.characters.find((x) => x.id === id);
        return c ? `${c.name}：${c.anchor}` : "";
      })
      .filter(Boolean)
      .join("；");

    const inputs: Record<string, unknown> = {
      shot_size: shot.shotSize,
      camera: shot.camera,
      location: shot.location,
      action: shot.action,
      emotion: shot.emotion || "",
      cast_anchor: castAnchor,
      style: plan.style,
      model: opts.imageModel,
      size: opts.imageSize,
      watermark: false,
    };
    shot.characters.slice(0, 3).forEach((id, i) => {
      const node = charNodes.get(id);
      if (node) inputs[`character${i + 1}`] = [node, 0];
    });
    // 尾帧接续：上一镜视频的最后一帧作为本镜画面的衔接参考。
    // 追加模式第一镜接旧图传进来的尾帧节点；多镜内部照旧接前一镜。
    if (opts.withVideo && opts.continuity !== false) {
      if (index === 0 && opts.prevTail) {
        inputs.previous_frame = [opts.prevTail, 0];
      } else if (index > 0) {
        inputs.previous_frame = [`shot_${n - 1}_tail`, 0];
      }
    }

    graph[frameId] = {
      class_type: "DramaShotFrame",
      inputs,
      _meta: { title: `${n}. ${shot.title}` },
    };
    graph[`shot_${n}_save`] = {
      class_type: "SaveImage",
      inputs: {
        images: [frameId, 0],
        filename_prefix: `storyforge/shot${pad(n)}_frame`,
      },
      _meta: { title: `分镜 ${n} 首帧` },
    };

    if (!opts.withVideo) return;

    const videoId = `shot_${n}_video`;
    const videoInputs: Record<string, unknown> = {
      first_frame: [frameId, 0],
      // 原始 Seedream URL：Seedance 只信任这个引用，不信任重编码后的 data URL
      first_frame_url: [frameId, 1],
      action: shot.action,
      emotion: shot.emotion || "",
      camera: shot.camera,
      dialogue: shot.dialogue || "",
      location: shot.location,
      cast_hint: shot.characters
        .map((id, i) => {
          const c = plan.characters.find((x) => x.id === id);
          return c ? `图片${i + 1}：${c.name}` : "";
        })
        .filter(Boolean)
        .join("；"),
      duration: shot.duration,
      resolution: opts.videoResolution,
      generate_audio: opts.generateAudio && shot.generateAudio !== false,
      model: opts.videoModel,
      watermark: false,
    };
    // 首帧被审核拦截时，视频节点会用这些“定妆原图 URL”走参考图模式
    shot.characters.slice(0, 3).forEach((id, i) => {
      const node = charNodes.get(id);
      if (node) videoInputs[`character${i + 1}_url`] = [node, 1];
    });
    graph[videoId] = {
      class_type: "DramaShotVideo",
      inputs: videoInputs,
      _meta: { title: `镜头 ${n} 视频` },
    };
    graph[`shot_${n}_save_video`] = {
      class_type: "SaveVideo",
      inputs: {
        video: [videoId, 0],
        filename_prefix: `storyforge/shot${pad(n)}_video`,
        format: "mp4",
      },
      _meta: { title: `镜头 ${n} 成片` },
    };

    // 只有还存在下一镜时才取尾帧，最后一镜不必多跑一次抽帧
    if (index < plan.shots.length - 1) {
      graph[`shot_${n}_tail`] = {
        class_type: "DramaContinuity",
        inputs: { video: [videoId, 0] },
        _meta: { title: `镜头 ${n} 尾帧` },
      };
    }
  });

  return graph;
}

export function planStats(plan: DramaPlan) {
  return {
    shots: plan.shots.length,
    characters: plan.characters.length,
    seconds: plan.shots.reduce((sum, s) => sum + s.duration, 0),
  };
}

/**
 * 分镜表 CSV：一行一镜，按出片顺序排。
 * 给剪辑软件当台词/分镜清单用——工具不碰剪辑，但要把台词交得出去。
 * 带 UTF-8 BOM，Excel 直接双击打开中文不乱码。
 */
export function storyboardCsv(plan: DramaPlan, order?: number[]): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const seq =
    order && order.length === plan.shots.length ? order : plan.shots.map((_, i) => i);
  const head = [
    "出片顺序",
    "镜号",
    "镜头名",
    "景别",
    "运镜",
    "场景",
    "动作",
    "情绪",
    "台词",
    "时长(秒)",
    "角色",
  ];
  const rows = seq.map((orig, pos) => {
    const s = plan.shots[orig];
    const names = s.characters
      .map((id) => plan.characters.find((c) => c.id === id)?.name)
      .filter(Boolean)
      .join("、");
    return [
      pos + 1,
      orig + 1,
      s.title,
      s.shotSize,
      s.camera,
      s.location,
      s.action,
      s.emotion ?? "",
      s.dialogue ?? "",
      s.duration,
      names,
    ];
  });
  return "\uFEFF" + [head, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
}

/* ------------------------------------------------------------------ *
 * 预算门限
 * 超出上限时截断镜头数 / 总时长，而不是让成本跟着模型的话走
 * ------------------------------------------------------------------ */

export interface Budget {
  maxShots: number;
  maxSeconds: number;
}

export function applyBudget(
  plan: DramaPlan,
  budget?: Budget | null
): { plan: DramaPlan; warnings: string[] } {
  if (!budget || (budget.maxShots <= 0 && budget.maxSeconds <= 0)) {
    return { plan, warnings: [] };
  }
  const warnings: string[] = [];
  let shots = [...plan.shots];

  if (budget.maxShots > 0 && shots.length > budget.maxShots) {
    warnings.push(`预算上限 ${budget.maxShots} 镜，已截取前 ${budget.maxShots} 镜`);
    shots = shots.slice(0, budget.maxShots);
  }

  const total = (list: DramaPlan["shots"]) => list.reduce((s, x) => s + x.duration, 0);
  while (shots.length > 1 && budget.maxSeconds > 0 && total(shots) > budget.maxSeconds) {
    const dropped = shots.pop()!;
    warnings.push(`总时长超上限 ${budget.maxSeconds}s，去掉「${dropped.title}」`);
  }
  if (shots.length === 1 && budget.maxSeconds > 0 && shots[0].duration > budget.maxSeconds) {
    const clamped = Math.max(4, budget.maxSeconds);
    warnings.push(`单镜时长 ${shots[0].duration}s 超上限，压到 ${clamped}s`);
    shots = [{ ...shots[0], duration: clamped }];
  }

  return { plan: { ...plan, shots }, warnings };
}

/* ------------------------------------------------------------------ *
 * 失败自动修复：把执行错误喂回模型，小改计划并沉淀经验
 * 纯函数，便于离线测试
 * ------------------------------------------------------------------ */

export function buildRepairMessages(
  failedPlan: DramaPlan,
  error: string,
  lessons: string[]
): { role: "system" | "user"; content: string }[] {
  const lessonText = lessons.length
    ? `\n## 已沉淀的经验（务必规避）\n${lessons.map((l) => `- ${l}`).join("\n")}\n`
    : "";

  const system = `你是短剧计划的修复者。这份计划在 ComfyUI / 生成模型执行时失败了，请输出一份修订后的计划。

## 输出（严格 JSON，不要 Markdown，不要解释）
{"plan": { ...与原计划完全相同的结构... }, "lesson": "一句 30 字以内的经验，说明以后如何避免同类失败"}

## 修复规则
- 尽量小改：优先调整 duration、shotSize、camera、dialogue、action、mode；不要推翻重来。
- 角色锚点逐字保留；style 尽量保留。
- 错误指向模型能力不足时降级：视频失败可把 mode 改成 "image"；时长超限就缩短。
- 错误指向参数不合法时改成合法值（duration 4-15，shotSize/camera 用受控词表）。
- 修订后的计划必须能独立执行，characters/shots 结构完整。
${lessonText}
原计划与错误信息见用户消息。`;

  const user = `原计划：\n${JSON.stringify(failedPlan)}\n\n执行错误：\n${error.slice(0, 1500)}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function parseRepair(raw: unknown): { plan: DramaPlan; lesson: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("修复结果不是一个对象");
  }
  const obj = raw as Record<string, unknown>;
  const parsed = parsePlan(obj.plan ?? obj);
  const lesson = typeof obj.lesson === "string" ? obj.lesson.trim().slice(0, 120) : "";
  return { plan: parsed.plan, lesson };
}
