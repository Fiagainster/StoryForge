import type {
  CameraMove,
  ComfyGraph,
  DramaCharacter,
  DramaPlan,
  DramaShot,
  MotionSetup,
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
/** 镜头数不在这里截断：上限归 applyBudget（可配置、会出警告），这里只做异常兜底 */
const MAX_SHOTS = 60;
const MAX_SHOT_SECONDS = 15;

export interface ParsedPlan {
  plan: DramaPlan;
  warnings: string[];
}

const text = (v: unknown, max = 400): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** 只留文件名：用户/模型常把完整路径写进来，内核只认工作区 input/ 下的相对名 */
const basename = (p: string) => p.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";

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

  const mode: DramaPlan["mode"] =
    obj.mode === "motion" ? "motion" : obj.mode === "image" ? "image" : "video";
  const title = text(obj.title, 40) || "未命名短剧";
  const style = text(obj.style, 500);

  // 动作迁移：素材是「一段参考视频 + 一张人物图」，不走分镜生成那条路
  let motion: MotionSetup | undefined;
  if (mode === "motion") {
    const m = (obj.motion || {}) as Record<string, unknown>;
    // 只出参考图时不需要参考视频：这一步根本不碰视频
    const stage: "stills" | "full" = m.stage === "stills" ? "stills" : "full";
    const referenceVideo = text(m.referenceVideo, 200);
    if (!referenceVideo && stage !== "stills") {
      throw new Error("动作迁移缺少参考视频文件名（motion.referenceVideo，文件需放在工作区 input/ 下）");
    }
    const secs = Number(m.referenceSeconds);
    motion = {
      referenceVideo: basename(referenceVideo),
      characterRef: basename(text(m.characterRef, 200)) || undefined,
      scene: text(m.scene, 500) || undefined,
      size: text(m.size, 20) || undefined,
      stage,
      characterImage: basename(text(m.characterImage, 200)) || undefined,
      animateMode: m.animateMode === "wan-std" ? "wan-std" : "wan-pro",
      checkImage: m.checkImage !== false,
      referenceSeconds: Number.isFinite(secs) ? clamp(Math.round(secs), 2, 30) : 0,
    };
  }

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
  if (!rawShots.length) {
    // 动作迁移只需要一镜（整段参考视频），没给就补一条占位，让分镜板有卡可看
    if (mode !== "motion") throw new Error("计划里没有镜头");
    rawShots.push({ title: "动作迁移", action: "把参考视频里的动作迁移到人物身上" });
  }

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
    // 动作迁移的景别/运镜由参考视频决定，这两个字段没有意义，不要拿它报警告
    if (mode !== "motion" && shotSize !== s.shotSize) {
      warnings.push(`镜头 ${index + 1} 景别不合法，回退到中景`);
    }
    const camera = CAMERA_MOVES.includes(s.camera as CameraMove)
      ? (s.camera as CameraMove)
      : "固定";
    if (mode !== "motion" && camera !== s.camera) {
      warnings.push(`镜头 ${index + 1} 运镜不合法，回退到固定`);
    }

    const rawDuration = Number(s.duration);
    const duration =
      mode === "motion"
        ? clamp(motion?.referenceSeconds || 20, 2, 30)
        : Number.isFinite(rawDuration)
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
    plan: { title, mode, style, characters, shots, motion },
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
/**
 * 动作迁移图：参考视频 + 人物参考图（+ 空镜背景） → 定妆 → wan2.2-animate-move → 落盘。
 *
 * 两条来自模型行为的硬约束，决定了这张图的形状：
 *   1. **move 保留的是人物图的背景**（不是参考视频的背景）。所以背景要先生成一张空镜，
 *      再让定妆图把人物放进这个场景——成片背景就是这张图，不需要任何抠像合成。
 *   2. 人物图必须与参考视频同比例、同景别占位，否则动作迁移会把人拉变形。
 *
 * 两个开关让「先看图、再跑视频」成立：
 *   stage=stills 只编译出图部分（背景 + 定妆），一个视频请求都不发；
 *   stage=full 且带 characterImage 时直接复用上一轮出的定妆图，不重新生成、不重复花钱。
 */
export function compileMotionPlan(plan: DramaPlan, opts: CompileOptions): ComfyGraph {
  const setup = plan.motion;
  if (!setup) throw new Error("动作迁移计划缺少 motion 配置");
  const graph: ComfyGraph = {};
  const size = setup.size || opts.imageSize;
  const stillsOnly = setup.stage === "stills";
  const reuse = (setup.characterImage || "").trim();

  // ---- 人物图：能复用就复用，复用不了才现生成 ----
  let charNode = "";
  let charUrlSlot: number | null = null;
  if (reuse) {
    graph["motion_char_reuse"] = {
      class_type: "LoadImage",
      inputs: { image: reuse },
      _meta: { title: `复用定妆 · ${reuse}` },
    };
    charNode = "motion_char_reuse";
  } else {
    const cast = plan.characters[0];
    const charInputs: Record<string, unknown> = {
      name: cast?.name || "主角",
      anchor: cast?.anchor || "古风汉服造型，广袖长裙，发髻与流苏发簪",
      style: plan.style,
      model: opts.imageModel,
      // 全身是硬要求：画幅占比要和参考视频里的人物接近，否则迁移会变形
      framing: "全身",
      size,
      watermark: false,
    };
    if (setup.characterRef) {
      graph["motion_face"] = {
        class_type: "LoadImage",
        inputs: { image: setup.characterRef },
        _meta: { title: `人物参考 · ${setup.characterRef}` },
      };
      charInputs.reference_image = ["motion_face", 0];
    }
    // 空镜背景：先定场景，再让定妆把人物放进去。背景图单独落盘，多镜头复用同一张
    const scene = (setup.scene || "").trim();
    if (scene) {
      graph["motion_bg"] = {
        class_type: "DramaBackdrop",
        inputs: {
          scene,
          style: plan.style,
          model: opts.imageModel,
          size,
          watermark: false,
        },
        _meta: { title: "空镜背景" },
      };
      graph["motion_bg_save"] = {
        class_type: "SaveImage",
        inputs: { images: ["motion_bg", 0], filename_prefix: "storyforge/motion_bg" },
        _meta: { title: "保存背景" },
      };
      charInputs.backdrop = ["motion_bg", 0];
    }
    graph["motion_char"] = {
      class_type: "DramaCharacter",
      inputs: charInputs,
      _meta: { title: `定妆 · ${cast?.name || "主角"}` },
    };
    graph["motion_char_save"] = {
      class_type: "SaveImage",
      inputs: { images: ["motion_char", 0], filename_prefix: "storyforge/motion_char" },
      _meta: { title: "保存定妆" },
    };
    charNode = "motion_char";
    charUrlSlot = 1;
  }

  // 只出图：到此为止。没有 WanAnimate 节点，就算误点生成也不会扣视频钱
  if (stillsOnly) return graph;

  // ---- 视频链路：参考视频先规整（模型只吃 2~30 秒、边长 ≤2048、≤200MB）----
  graph["motion_ref"] = {
    class_type: "LoadVideo",
    inputs: { video: setup.referenceVideo },
    _meta: { title: `参考视频 · ${setup.referenceVideo}` },
  };
  graph["motion_fit"] = {
    class_type: "VideoFit",
    inputs: { video: ["motion_ref", 0], max_seconds: 30, max_width: 1080 },
    _meta: { title: "视频规整" },
  };
  const wanInputs: Record<string, unknown> = {
    character: [charNode, 0],
    video: ["motion_fit", 0],
    mode: setup.animateMode,
    check_image: setup.checkImage,
    watermark: false,
    duration: setup.referenceSeconds || 0,
  };
  // 定妆节点的第 2 输出是原始 URL，命中时内核省一次上传；复用图没有 URL，就不接
  if (charUrlSlot !== null) {
    wanInputs.character_url = [charNode, charUrlSlot];
  }
  graph["shot_1_video"] = {
    class_type: "WanAnimate",
    inputs: wanInputs,
    _meta: { title: "动作迁移" },
  };
  graph["shot_1_save"] = {
    class_type: "SaveVideo",
    inputs: {
      video: ["shot_1_video", 0],
      filename_prefix: "storyforge/motion",
      format: "mp4",
    },
    _meta: { title: "保存成片" },
  };
  return graph;
}

export function compilePlan(plan: DramaPlan, opts: CompileOptions): ComfyGraph {
  // 动作迁移是另一条链路：动作由参考视频决定，不经过「首帧 → 图生视频」
  if (plan.mode === "motion") return compileMotionPlan(plan, opts);

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

  const system = `你是短剧计划的修复者。这份计划在生成模型执行时失败了，请输出一份修订后的计划。

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
