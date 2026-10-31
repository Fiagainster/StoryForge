import { useStore } from "../lib/store";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { Btn, I, IconBtn, Spinner, Tag, cx } from "./ui";

export function StatusBar({
  onOpenSettings,
  chatOpen,
  onToggleChat,
  busy,
  stage,
}: {
  onOpenSettings: () => void;
  chatOpen: boolean;
  onToggleChat: () => void;
  busy: boolean;
  stage: string;
}) {
  const { env, comfy, config } = useStore();

  const running = !!comfy?.running; // 内核常驻，恒为真
  const ffmpegReady = !!env?.ffmpegReady;
  const modelsReady = !!env?.llmKeySet;
  const missing = [
    !env?.nodesInstalled ? "提示词缺失" : null,
    !ffmpegReady ? "ffmpeg 缺失" : null,
  ].filter(Boolean) as string[];

  return (
    <header className="no-select flex h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-[var(--line-1)] bg-[var(--bg-base)] pl-3.5 pr-2.5">
      <div className="flex shrink-0 items-center gap-2">
        <div className="grid size-[22px] place-items-center rounded-[7px] bg-gradient-to-br from-[#f0c887] to-[#c98f42]">
          <span className="t-11 font-bold leading-none text-[#241a09]">S</span>
        </div>
        <span className="t-13 font-medium tracking-[0.01em] text-[var(--fg-1)]">StoryForge</span>
      </div>

      <span className="h-4 w-[0.5px] shrink-0 bg-[var(--line-2)]" />

      <ProjectSwitcher />

      <span className="h-4 w-[0.5px] shrink-0 bg-[var(--line-2)]" />

      {/* 内核：常驻，没有启停 */}
      <div className="flex shrink-0 items-center gap-1.5">
        <span
          className={cx(
            "size-1.5 rounded-full",
            running ? "bg-[var(--ok)] dot-live" : "bg-[var(--fg-4)]"
          )}
        />
        <span className="t-12 text-[var(--fg-2)]">内核</span>
        <span className="t-11 tabular text-[var(--fg-4)]">
          {running ? (ffmpegReady ? "就绪" : "就绪 · 缺 ffmpeg") : "未就绪"}
        </span>
      </div>

      {/* 模型 */}
      <button
        onClick={onOpenSettings}
        className="flex min-w-0 shrink items-center gap-1.5 rounded-[6px] px-1 py-0.5 transition-colors hover:bg-[var(--bg-2)]"
        title={modelsReady ? "对话模型已接入 · 点击查看设置" : "还没接入对话模型"}
      >
        <span
          className={cx("size-1.5 rounded-full", modelsReady ? "bg-[var(--ok)]" : "bg-[var(--fg-4)]")}
        />
        <span className="t-12 truncate text-[var(--fg-3)]">
          {modelsReady ? env?.llmModel || "模型已接入" : "未接入模型"}
        </span>
      </button>

      {env && !env.arkKeySet ? <Tag tone="quiet">ARK 未配置</Tag> : null}
      {missing.length ? <Tag tone="warn">{missing.join(" · ")}</Tag> : null}

      {busy && stage ? (
        <div className="flex min-w-0 items-center gap-1.5 text-[var(--accent)] fade-in">
          <Spinner className="size-3" />
          <span className="t-12 truncate">{stage}</span>
        </div>
      ) : null}

      <div className="flex-1" />

      {!chatOpen ? (
        <Btn
          size="sm"
          variant="outline"
          icon={I.panel(13)}
          onClick={onToggleChat}
          title="展开对话面板 (Ctrl+B)"
        >
          导演台
        </Btn>
      ) : (
        <IconBtn label="收起导演台 (Ctrl+B)" onClick={onToggleChat}>
          {I.panel(14)}
        </IconBtn>
      )}
      <Btn size="sm" variant="ghost" icon={I.settings(13)} onClick={onOpenSettings}>
        设置
      </Btn>
    </header>
  );
}
