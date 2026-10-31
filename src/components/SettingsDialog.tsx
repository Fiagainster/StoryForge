import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import * as api from "../lib/api";
import { humanError } from "../lib/agent";
import { LIB_STATS, LIB_VERSION, MISSING_CORE, REFERENCE_NODES } from "../lib/nodeSearch";
import { Btn, I, IconBtn, Spinner, Tag } from "./ui";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { config, env, saveConfig, clearLearnings, addLearning, removeLearning, setProjectsRoot } =
    useStore();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [videoModel, setVideoModel] = useState("");
  const [arkKey, setArkKey] = useState("");
  const [resolution, setResolution] = useState("720p");
  const [genAudio, setGenAudio] = useState(true);
  const [videoProvider, setVideoProvider] = useState<"ark" | "jimeng">("ark");
  const [jimengAk, setJimengAk] = useState("");
  const [jimengSk, setJimengSk] = useState("");
  const [maxShots, setMaxShots] = useState("3");
  const [maxSeconds, setMaxSeconds] = useState("30");
  const [maxCny, setMaxCny] = useState("");
  const [costMode, setCostMode] = useState<"observe" | "warn" | "cap">("observe");
  const [root, setRoot] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!config) return;
    setRoot(config.projectRoot || "");
    setBaseUrl(config.llm?.baseUrl || "");
    setApiKey(config.llm?.apiKey || "");
    setModel(config.llm?.model || "");
    setImageModel(config.image?.model || "");
    setVideoModel(config.video?.model || "");
    setArkKey(config.ark?.apiKey || "");
    setResolution(config.video?.resolution || "720p");
    setVideoProvider(config.video?.provider ?? "ark");
    setJimengAk(config.jimeng?.accessKey || "");
    setJimengSk(config.jimeng?.secretKey || "");
    setGenAudio(config.video?.generateAudio !== false);
    setMaxShots(String(config.budget?.maxShots ?? 3));
    setMaxSeconds(String(config.budget?.maxSeconds ?? 30));
    setMaxCny(config.budget?.maxCny ? String(config.budget.maxCny) : "");
    setCostMode(config.budget?.mode ?? "observe");
  }, [config]);

  const buildPatch = () =>
    ({
      projectRoot: root.trim(),
      llm: { baseUrl, apiKey, model },
      ark: { apiKey: arkKey },
      image: { model: imageModel },
      video: { model: videoModel, resolution, generateAudio: genAudio, provider: videoProvider },
      jimeng: { accessKey: jimengAk, secretKey: jimengSk },
      budget: {
        maxShots: Math.max(1, Number(maxShots) || 3),
        maxSeconds: Math.max(4, Number(maxSeconds) || 30),
        maxCny: Math.max(0, Number(maxCny) || 0),
        mode: costMode,
      },
    }) as any;

  const save = async () => {
    setSaving(true);
    await saveConfig(buildPatch());
    setSaving(false);
    onClose();
  };

  // 测试连接走的是落盘后的配置，所以先存再打一次最小请求
  const ping = async () => {
    setTesting(true);
    setTest(null);
    try {
      await saveConfig(buildPatch());
      const r = await api.llmPing();
      setTest({
        ok: true,
        msg: `${r.ms}ms · ${r.tokens} tokens · 返回「${r.reply || "空"}」`,
      });
    } catch (e) {
      setTest({ ok: false, msg: humanError(String(e)) });
    } finally {
      setTesting(false);
    }
  };

  const learnings = config?.memory?.learnings ?? [];

  /* 经验记忆手动编辑：单条删除 + 手动添加 */
  const [newLesson, setNewLesson] = useState("");
  const addLesson = async () => {
    if (!newLesson.trim()) return;
    await addLearning(newLesson);
    setNewLesson("");
  };

  /* 项目根目录：独立保存（换根会把当前项目先落盘到旧位置） */
  const [projRoot, setProjRoot] = useState("");
  const [projRootSaving, setProjRootSaving] = useState(false);
  useEffect(() => {
    void api
      .projectRoot()
      .then(setProjRoot)
      .catch(() => {});
  }, []);
  const saveProjRoot = async () => {
    const p = projRoot.trim();
    if (!p) return;
    setProjRootSaving(true);
    await setProjectsRoot(p);
    setProjRootSaving(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-6 backdrop-blur-[2px] fade-in"
      onClick={onClose}
    >
      <div
        className="popover flex max-h-[86vh] w-[600px] flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center gap-3 px-5">
          <span className="t-16 font-medium text-[var(--fg-1)]">设置</span>
          <span className="t-11 text-[var(--fg-4)]">Key 只存本机配置文件，不上传</span>
          <div className="flex-1" />
          <IconBtn label="关闭 (Esc)" onClick={onClose}>
            {I.close(14)}
          </IconBtn>
        </div>
        <div className="hairline" />

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <Section
            title="对话模型"
            hint="策划与分镜，需支持 JSON 输出"
            action={
              <Btn
                size="xs"
                variant="outline"
                onClick={() => void ping()}
                disabled={testing}
                icon={testing ? <Spinner className="size-3" /> : I.bolt(11)}
              >
                {testing ? "测试中" : "测试连接"}
              </Btn>
            }
          >
            <Field label="Base URL" hint="DeepSeek：https://api.deepseek.com/v1">
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="field" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="API Key" hint={env?.llmKeySet ? "已配置" : "未配置"}>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="field font-mono"
                />
              </Field>
              <Field label="模型 ID" hint="例 deepseek-flash">
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="field font-mono"
                />
              </Field>
            </div>
            {test ? (
              <div
                className={`flex items-start gap-1.5 rounded-[9px] bg-[var(--bg-2)] px-2.5 py-2 t-11 leading-[17px] shadow-[inset_0_0_0_0.5px_var(--line-1)] fade-in ${
                  test.ok ? "text-[var(--fg-2)]" : "text-[var(--err)]"
                }`}
              >
                <span className="mt-[2px] shrink-0">
                  {test.ok ? (
                    <span className="text-[var(--ok)]">{I.check(11)}</span>
                  ) : (
                    I.close(11)
                  )}
                </span>
                <span className="min-w-0 break-words">{test.msg}</span>
              </div>
            ) : null}
          </Section>

          <Section title="生成模型" hint="ARK 直连，改完保存即生效">
            <Field label="ARK Key" hint={env?.arkKeySet ? "已配置" : "未配置"}>
              <input
                type="password"
                value={arkKey}
                onChange={(e) => setArkKey(e.target.value)}
                placeholder="ark-..."
                className="field font-mono"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="图像模型">
                <input
                  value={imageModel}
                  onChange={(e) => setImageModel(e.target.value)}
                  className="field font-mono"
                />
              </Field>
              <Field label="视频模型">
                <input
                  value={videoModel}
                  onChange={(e) => setVideoModel(e.target.value)}
                  className="field font-mono"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="视频供应商">
                <select
                  value={videoProvider}
                  onChange={(e) => setVideoProvider(e.target.value as "ark" | "jimeng")}
                  className="field"
                >
                  <option value="ark">火山 ARK · Seedance（默认）</option>
                  <option value="jimeng">即梦 · 火山 CV（AK/SK）</option>
                </select>
              </Field>
              <Field label="视频分辨率">
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  className="field"
                >
                  <option value="480p">480p · 省成本</option>
                  <option value="720p">720p · 默认</option>
                  <option value="1080p">1080p · 10bit H.265</option>
                </select>
              </Field>
              <Field label="同步音频">
                <label className="flex h-[31px] cursor-pointer items-center gap-2 t-12 text-[var(--fg-2)]">
                  <input
                    type="checkbox"
                    checked={genAudio}
                    onChange={(e) => setGenAudio(e.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  生成对白 / 环境声
                </label>
              </Field>
            </div>
            {videoProvider === "jimeng" ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="即梦 Access Key">
                  <input
                    value={jimengAk}
                    onChange={(e) => setJimengAk(e.target.value)}
                    placeholder="VOLC_ACCESSKEY"
                    className="field font-mono"
                  />
                </Field>
                <Field label="即梦 Secret Key">
                  <input
                    value={jimengSk}
                    onChange={(e) => setJimengSk(e.target.value)}
                    type="password"
                    placeholder="VOLC_SECRETKEY"
                    className="field font-mono"
                  />
                </Field>
                <p className="col-span-2 t-11 leading-[17px] text-[var(--fg-4)]">
                  即梦只支持首帧图生视频：要求尾帧、多图参考或音频的镜头会自动回落
                  ARK，每镜的状态里会写明。计价按条估算（官方按条刊例价未公开）。
                </p>
              </div>
            ) : null}
          </Section>

          <Section title="预算" hint="超出自动截断">
            <div className="grid grid-cols-2 gap-3">
              <Field label="单次最多镜头">
                <input
                  value={maxShots}
                  onChange={(e) => setMaxShots(e.target.value)}
                  inputMode="numeric"
                  className="field tabular"
                />
              </Field>
              <Field label="总时长上限（秒）">
                <input
                  value={maxSeconds}
                  onChange={(e) => setMaxSeconds(e.target.value)}
                  inputMode="numeric"
                  className="field tabular"
                />
              </Field>
              <Field label="单次金额上限（元）" hint="留空或 0 = 不限">
                <input
                  value={maxCny}
                  onChange={(e) => setMaxCny(e.target.value)}
                  inputMode="decimal"
                  placeholder="不限"
                  className="field tabular"
                />
              </Field>
              <Field label="超限处理">
                <select
                  value={costMode}
                  onChange={(e) => setCostMode(e.target.value as "observe" | "warn" | "cap")}
                  className="field"
                >
                  <option value="observe">只显示（observe）</option>
                  <option value="warn">提醒但放行（warn）</option>
                  <option value="cap">拦截执行（cap）</option>
                </select>
              </Field>
            </div>
            <p className="t-11 leading-[17px] text-[var(--fg-4)]">
              出计划后先等你确认；确认时超过上限的镜头会被截掉，不会静默烧额度。金额按 ARK
              官方价估算（Seedream 按张、Seedance 按秒），确认门显示区间，cap
              模式下含重试缓冲超限会被拦下。
            </p>
          </Section>

          <Section title="执行内核" hint="常驻，无需启动">
            <div className="grid grid-cols-[120px_1fr] gap-3">
              <Field label="项目根目录" hint="留空自动识别">
                <input
                  value={root}
                  onChange={(e) => setRoot(e.target.value)}
                  placeholder={env?.projectRoot || "自动识别"}
                  className="field font-mono"
                />
              </Field>
            </div>
            <p className="t-11 leading-[17px] text-[var(--fg-4)]">
              生成算力在云端 ARK；本地内核只做图的派发、收文件和像素杂活（占位图 / 缩放 / 抽帧 / 拼接），
              不占显存、没有启动等待。停用旧的「空闲自动停」已随 ComfyUI 一起退役。
            </p>
            <div className="space-y-1 rounded-[10px] bg-[var(--bg-2)] p-3 t-11 font-mono leading-[17px] text-[var(--fg-4)]">
              <Path label="配置" value={env?.configPath} />
              <Path label="根目录" value={env?.projectRoot} />
              <Path label="工作区" value={env?.comfyBase} />
              <Path label="提示词" value={`${env?.projectRoot || ""}\\engine\\prompts`} />
              <div className="flex gap-2">
                <span className="w-12 shrink-0 text-[var(--fg-3)]">ffmpeg</span>
                <span className={env?.ffmpegReady ? "text-[var(--ok)]" : "text-[var(--err)]"}>
                  {env?.ffmpegReady ? "已就绪" : "缺失（拼接/抽帧不可用）"}
                </span>
              </div>
              <div className="flex gap-2">
                <span className="w-12 shrink-0 text-[var(--fg-3)]">节点</span>
                <span className={env?.nodesInstalled ? "text-[var(--ok)]" : "text-[var(--err)]"}>
                  {env?.nodesInstalled ? "已就绪" : "缺失"}
                </span>
              </div>
            </div>
          </Section>

          <Section title="项目存放位置" hint="一个项目一个文件夹">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field label="项目根目录" hint="项目都建在这个文件夹下">
                  <input
                    value={projRoot}
                    onChange={(e) => setProjRoot(e.target.value)}
                    className="field font-mono"
                  />
                </Field>
              </div>
              <Btn
                size="sm"
                variant="outline"
                onClick={() => void saveProjRoot()}
                disabled={projRootSaving || !projRoot.trim()}
              >
                {projRootSaving ? "切换中…" : "切换"}
              </Btn>
            </div>
            <p className="t-11 leading-[17px] text-[var(--fg-4)]">
              切换只改「以后的项目建在哪」，已建的文件夹不会自动搬动；新根下有同名项目时会自动接着用。
            </p>
          </Section>

          <Section title="经验记忆" hint="失败修复时自动提炼，也可手动编辑">
            <p className="t-11 leading-[17px] text-[var(--fg-4)]">
              执行失败自动修复时提炼一句经验，之后每次出计划都会带上，越用越贴合你的机器与口味。
            </p>
            {learnings.length ? (
              <div className="max-h-[168px] space-y-1.5 overflow-y-auto">
                {learnings.map((l, i) => (
                  <div
                    key={i}
                    className="group flex items-start gap-1.5 border-l-[1.5px] border-[var(--line-3)] pl-2.5 t-12 leading-[18px] text-[var(--fg-2)]"
                  >
                    <span className="min-w-0 flex-1">{l}</span>
                    <button
                      className="mt-px shrink-0 text-[var(--fg-4)] opacity-0 transition-opacity hover:text-[var(--err)] group-hover:opacity-100"
                      title="删除这条经验"
                      onClick={() => void removeLearning(i)}
                    >
                      {I.close(11)}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="t-12 text-[var(--fg-4)]">还没有沉淀任何经验。</div>
            )}
            <div className="flex items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded-[7px] border border-[var(--line-2)] bg-[var(--bg-2)] px-2.5 py-1.5 t-12 text-[var(--fg-1)] outline-none placeholder:text-[var(--fg-4)] focus:border-[var(--line-3)]"
                placeholder="手动加一条经验，比如「 Seedance 不接受真人脸」"
                value={newLesson}
                onChange={(e) => setNewLesson(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addLesson();
                }}
              />
              <Btn size="sm" variant="outline" onClick={() => void addLesson()} disabled={!newLesson.trim()}>
                添加
              </Btn>
            </div>
            {learnings.length ? (
              <Btn size="sm" variant="ghost" onClick={() => void clearLearnings()}>
                清空记忆
              </Btn>
            ) : null}
          </Section>

          <Section title="节点库" hint={`内核 ${LIB_VERSION}`}>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="可直接用" value={LIB_STATS.usable} tone="good" />
              <Stat label="需模型权重" value={LIB_STATS.needWeights} />
              <Stat label="第三方 API" value={LIB_STATS.partner} />
            </div>
            <p className="t-11 leading-[17px] text-[var(--fg-4)]">
              计划模式只把分镜语法与角色锚点交给对话模型，节点图由编译器生成，再按{" "}
              {LIB_STATS.usable} 个内核节点校验连线与类型；目录外的节点会在提交时被内核拒收。
            </p>
            {MISSING_CORE.length ? (
              <div className="flex items-center gap-2">
                <Tag tone="warn">缺少核心节点</Tag>
                <span className="t-11 text-[var(--fg-3)]">{MISSING_CORE.join("、")}</span>
              </div>
            ) : null}
          </Section>
        </div>

        <div className="hairline" />
        <div className="flex shrink-0 items-center justify-end gap-2 px-5 py-3">
          <Btn size="sm" variant="ghost" onClick={onClose}>
            取消
          </Btn>
          <Btn size="sm" variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

function Path({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-12 shrink-0 text-[var(--fg-3)]">{label}</span>
      <span className="min-w-0 break-all">{value || "—"}</span>
    </div>
  );
}

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2.5">
        <span className="t-12 font-medium tracking-[0.02em] text-[var(--fg-1)]">{title}</span>
        {hint ? <span className="t-11 text-[var(--fg-4)]">{hint}</span> : null}
        <div className="hairline flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "good" }) {
  return (
    <div className="rounded-[10px] bg-[var(--bg-2)] px-3 py-2 shadow-[inset_0_0_0_0.5px_var(--line-1)]">
      <div
        className={`t-16 font-medium tabular ${
          tone === "good" ? "text-[var(--accent)]" : "text-[var(--fg-1)]"
        }`}
      >
        {value}
      </div>
      <div className="t-11 text-[var(--fg-4)]">{label}</div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="t-12 text-[var(--fg-2)]">{label}</span>
        {hint ? <span className="truncate t-11 text-[var(--fg-4)]">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}
