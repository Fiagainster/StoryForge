import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { CAMERA_MOVES, SHOT_SIZES } from "../lib/plan";
import type { ChatMessage, ChatStep } from "../types";
import { Btn, I, IconBtn, Spinner, Tag, cx } from "./ui";

const QUICK = ["先来一张测试画面", "雨夜便利店，冷调", "9:16 空镜，无对白"];

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/* ------------------------------------------------------------------ *
 * 过程呈现：思考 / 工具调用
 * 默认折成一行，点开才看细节——过程不该抢正文的注意力，但必须看得见
 * ------------------------------------------------------------------ */

const dur = (s: ChatStep) => {
  if (!s.endedAt) return "";
  const ms = s.endedAt - s.startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
};

function ThinkBlock({ step, text }: { step: ChatStep; text: string }) {
  const [open, setOpen] = useState(false);
  const running = step.status === "running";
  return (
    <div className="mb-0.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="no-select -ml-1 flex items-center gap-1.5 rounded-[6px] px-1 py-[3px] transition-colors hover:bg-[var(--bg-2)]"
      >
        <span className={running ? "text-[var(--accent)]" : "text-[var(--fg-4)]"}>
          {I.spark(11)}
        </span>
        {running ? (
          <span className="shimmer t-12">思考中</span>
        ) : (
          <span className="t-12 text-[var(--fg-3)]">已思考</span>
        )}
        {!running && text ? (
          <span className="t-11 tabular text-[var(--fg-4)]">{text.length} 字</span>
        ) : null}
        <span className={cx("text-[var(--fg-4)] transition-transform", open ? "rotate-90" : "")}>
          {I.chevronRight(10)}
        </span>
      </button>
      {open ? (
        <div className="mt-1 max-h-[220px] selectable overflow-y-auto whitespace-pre-wrap break-words border-l-[0.5px] border-[var(--line-2)] pl-2.5 t-12 leading-[19px] text-[var(--fg-3)]">
          {text || "（这一轮没有返回思考内容）"}
        </div>
      ) : null}
    </div>
  );
}

function StepRow({ step }: { step: ChatStep }) {
  const [open, setOpen] = useState(false);
  const running = step.status === "running";
  // 用户主动停止不算出错：不标红，只灰化收尾
  const stopped = step.note === "已停止";
  const failed = step.status === "error" && !stopped;
  const hasDetail = !!step.detail;

  return (
    <div>
      <button
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={cx(
          "no-select -ml-1 flex w-full items-center gap-1.5 rounded-[6px] px-1 py-[3px] text-left transition-colors",
          hasDetail ? "hover:bg-[var(--bg-2)]" : "cursor-default"
        )}
      >
        <span
          className={cx(
            "grid size-3.5 shrink-0 place-items-center",
            failed ? "text-[var(--err)]" : running ? "text-[var(--accent)]" : "text-[var(--fg-4)]"
          )}
        >
          {running ? <Spinner className="size-3" /> : failed ? I.close(11) : I.check(11)}
        </span>
        <span
          className={cx("truncate t-12", failed ? "text-[var(--err)]" : "text-[var(--fg-2)]")}
        >
          {step.title}
        </span>
        <span className="flex-1" />
        <span className="shrink-0 t-11 tabular text-[var(--fg-4)]">
          {step.note || (running ? "" : dur(step))}
        </span>
        {hasDetail ? (
          <span
            className={cx("shrink-0 text-[var(--fg-4)] transition-transform", open ? "rotate-90" : "")}
          >
            {I.chevronRight(10)}
          </span>
        ) : null}
      </button>
      {open && hasDetail ? (
        <pre className="mb-1.5 mt-1 max-h-[200px] selectable overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[var(--bg-2)] p-2 t-11 leading-[17px] text-[var(--fg-3)]">
          {step.detail}
        </pre>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 一条消息：用户右气泡、助手纯文本（无框无底），hover 出复制
 * ------------------------------------------------------------------ */

function Message({ m }: { m: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  const isUser = m.role === "user";
  const isError = m.kind === "error";

  const steps = m.steps ?? [];
  const think = steps.find((s) => s.kind === "think");
  const tools = steps.filter((s) => s.kind !== "think");
  const idle = !m.content && !think && !tools.length;

  const copy = () => {
    void navigator.clipboard?.writeText(m.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className={cx("group relative fade-up", isUser ? "flex justify-end" : "")}>
      {isUser ? (
        <div className="max-w-[86%] rounded-[16px] rounded-br-[6px] bg-[var(--bg-3)] px-3.5 py-[9px] t-13 selectable whitespace-pre-wrap break-words text-[var(--fg-1)]">
          {m.content}
        </div>
      ) : (
        <div className="pr-6">
          {think ? <ThinkBlock step={think} text={m.thinking || ""} /> : null}
          {tools.length ? (
            <div className="mb-1.5">
              {tools.map((s) => (
                <StepRow key={s.id} step={s} />
              ))}
            </div>
          ) : null}

          {m.content ? (
            <div
              className={cx(
                "t-13 selectable whitespace-pre-wrap break-words leading-[22px]",
                isError ? "text-[var(--fg-2)]" : "text-[var(--fg-1)]"
              )}
            >
              {m.content}
              {m.streaming ? <span className="caret" /> : null}
            </div>
          ) : isError ? null : m.streaming || idle ? (
            <div className="py-0.5 t-13">
              <span className="shimmer">正在生成</span>
            </div>
          ) : null}

          {m.meta?.degraded ? (
            <div className="mt-2 flex items-center gap-1.5 t-11 text-[var(--fg-3)]">
              <Tag tone="quiet">本地占位图</Tag>
              没接对话模型，用内置图跑通了链路
            </div>
          ) : null}
        </div>
      )}

      {m.content && !m.streaming && !idle ? (
        <IconBtn
          label={copied ? "已复制" : "复制"}
          onClick={copy}
          className={cx(
            "absolute top-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100",
            isUser ? "-left-8" : "-right-1"
          )}
        >
          {copied ? I.check(12) : I.copy(12)}
        </IconBtn>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 导演台
 * ------------------------------------------------------------------ */

export function ChatPanel({ width, onCollapse }: { width: number; onCollapse: () => void }) {
  const {
    messages,
    send,
    busy,
    stage,
    sessions,
    activeId,
    switchSession,
    newSession,
    deleteSession,
    stopTurn,
  } = useStore();
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [stick, setStick] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const startedAt = useRef(0);

  const active = sessions.find((s) => s.id === activeId);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [messages, busy, stick]);

  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    startedAt.current = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - startedAt.current), 500);
    return () => clearInterval(t);
  }, [busy]);

  useEffect(() => {
    taRef.current?.focus();
  }, [activeId]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 72);
  };

  const submit = () => {
    if (!text.trim() || busy) return;
    void send(text);
    setText("");
    if (taRef.current) taRef.current.style.height = "auto";
    setStick(true);
  };

  const jumpToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setStick(true);
  };

  return (
    <section
      style={{ width }}
      className="relative flex h-full min-h-0 shrink-0 flex-col bg-[var(--bg-1)]"
    >
      {/* 头部：会话切换 */}
      <div className="no-select relative flex h-12 shrink-0 items-center gap-1.5 px-3">
        <button
          onClick={() => setPickerOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1 rounded-[7px] px-1.5 py-1 transition-colors hover:bg-[var(--bg-2)]"
        >
          <span className="truncate t-13 text-[var(--fg-1)]">{active?.title || "新对话"}</span>
          <span className="shrink-0 text-[var(--fg-4)]">{I.chevron(12)}</span>
        </button>
        <div className="flex-1" />
        <IconBtn label="新建对话" onClick={newSession} disabled={busy}>
          {I.plus(14)}
        </IconBtn>
        <IconBtn label="收起导演台 (Ctrl+B)" onClick={onCollapse}>
          {I.panel(14)}
        </IconBtn>

        {pickerOpen ? (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setPickerOpen(false)} />
            <div className="popover absolute left-2 top-11 z-40 w-[268px] p-1.5">
              <div className="px-2 pb-1.5 pt-1 t-11 tracking-wide text-[var(--fg-4)]">
                对话 · {sessions.length}
              </div>
              <div className="max-h-[280px] overflow-y-auto">
                {sessions.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => {
                      switchSession(s.id);
                      setPickerOpen(false);
                    }}
                    className={cx(
                      "group flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 transition-colors",
                      s.id === activeId ? "bg-[var(--bg-hover)]" : "hover:bg-[var(--bg-hover)]"
                    )}
                  >
                    <span
                      className={cx(
                        "size-1 shrink-0 rounded-full",
                        s.id === activeId ? "bg-[var(--accent)]" : "bg-transparent"
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate t-12 text-[var(--fg-1)]">{s.title}</span>
                      <span className="block t-11 text-[var(--fg-4)]">
                        {s.messages.length} 条 · {s.runs.length} 次执行
                      </span>
                    </span>
                    {sessions.length > 1 ? (
                      <IconBtn
                        label="删除对话"
                        className="size-6 opacity-0 group-hover:opacity-100 hover:text-[var(--err)]"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteSession(s.id);
                        }}
                      >
                        {I.trash(12)}
                      </IconBtn>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </div>

      {/* 消息流 */}
      <div
        ref={listRef}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-2 pt-2"
      >
        {messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}

        {busy && !messages.some((m) => m.streaming) ? (
          <div className="flex items-center gap-2 pt-0.5 t-12 text-[var(--fg-3)] fade-in">
            <Spinner className="size-3 text-[var(--accent)]" />
            <span className="text-[var(--fg-2)]">{stage || "处理中"}</span>
            <span className="tabular text-[var(--fg-4)]">{clock(elapsed)}</span>
          </div>
        ) : null}
      </div>

      {!stick ? (
        <div className="pointer-events-none absolute bottom-[152px] left-1/2 z-20 -translate-x-1/2">
          <button
            onClick={jumpToBottom}
            className="pointer-events-auto grid size-7 place-items-center rounded-full bg-[var(--bg-3)] text-[var(--fg-2)] shadow-[inset_0_0_0_0.5px_var(--line-2),0_8px_24px_-8px_rgba(0,0,0,0.7)] transition-colors hover:text-[var(--fg-1)]"
            title="回到底部"
          >
            {I.down(13)}
          </button>
        </div>
      ) : null}

      {/* 输入区：这里只说话不动手，动手的事全在画布上 */}
      <div className="shrink-0 px-3 pb-3 pt-1">
        {messages.length <= 2 ? (
          <div className="no-select mb-2 flex flex-wrap gap-1.5">
            {QUICK.map((q) => (
              <Btn key={q} size="xs" variant="outline" onClick={() => void send(q)} disabled={busy}>
                {q}
              </Btn>
            ))}
          </div>
        ) : null}

        <div className="rounded-[16px] bg-[var(--bg-2)] shadow-[inset_0_0_0_0.5px_var(--line-2)] transition-shadow focus-within:shadow-[inset_0_0_0_1px_var(--accent-dim)]">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 168) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="说你想拍什么"
            className="w-full resize-none bg-transparent px-3.5 pt-3 t-13 leading-[21px] text-[var(--fg-1)] outline-none placeholder:text-[var(--fg-4)] selectable"
          />
          <div className="no-select flex items-center gap-2 px-2 pb-2 pl-3.5">
            <span className="t-11 text-[var(--fg-4)]">
              {busy ? `${stage || "处理中"} · ${clock(elapsed)}` : "Enter 发送 · Shift+Enter 换行"}
            </span>
            <div className="flex-1" />
            {busy ? (
              <button
                onClick={() => void stopTurn()}
                title="停止这一轮（掐断模型输出，画布保持原样）"
                className="grid size-7 place-items-center rounded-full bg-[var(--bg-3)] text-[var(--fg-2)] transition-colors hover:bg-[var(--err)] hover:text-white"
              >
                <span className="size-2.5 rounded-[2px] bg-current" />
              </button>
            ) : (
            <button
              onClick={submit}
              disabled={!text.trim() || busy}
              title="发送"
              className={cx(
                "grid size-7 place-items-center rounded-full transition-all",
                text.trim() && !busy
                  ? "bg-[var(--fg-1)] text-[#0b0b0d] hover:bg-white"
                  : "bg-[var(--bg-3)] text-[var(--fg-4)]"
              )}
            >
              {I.send(14)}
            </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
