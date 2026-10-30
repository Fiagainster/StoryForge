import { useCallback, useEffect, useRef, useState } from "react";
import { StatusBar } from "./components/StatusBar";
import { ChatPanel } from "./components/ChatPanel";
import { Workspace } from "./components/Workspace";
import { SettingsDialog } from "./components/SettingsDialog";
import { I, IconBtn } from "./components/ui";
import { useStore } from "./lib/store";

const WIDTH_KEY = "storyforge.chatWidth";
const COLLAPSE_KEY = "storyforge.chatCollapsed";
const MIN_W = 340;
const MAX_W = 640;

function readWidth() {
  const raw = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(raw) && raw >= MIN_W && raw <= MAX_W ? raw : 412;
}

export default function App() {
  const { init, refreshComfy, error, clearError, ready, stage, busy } = useStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem(COLLAPSE_KEY) !== "1");
  const [width, setWidth] = useState(readWidth);
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const timer = setInterval(() => void refreshComfy(), 12_000);
    return () => clearInterval(timer);
  }, [refreshComfy]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => clearError(), 9000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  const toggleChat = useCallback(() => {
    setChatOpen((v) => !v);
  }, []);

  // 折叠状态单独记：updater 必须是纯函数，localStorage 别写在里面
  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, chatOpen ? "0" : "1");
  }, [chatOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleChat();
      }
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleChat]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const next = Math.min(MAX_W, Math.max(MIN_W, d.startW + (e.clientX - d.startX)));
      setWidth(next);
    };
    const up = () => {
      drag.current = null;
      setDragging(false);
      setWidth((w) => {
        localStorage.setItem(WIDTH_KEY, String(w));
        return w;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging]);

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-[var(--bg-base)]">
      <StatusBar
        onOpenSettings={() => setSettingsOpen(true)}
        chatOpen={chatOpen}
        onToggleChat={toggleChat}
        busy={busy}
        stage={stage}
      />

      <div className="relative flex min-h-0 flex-1">
        {chatOpen ? (
          <>
            <ChatPanel width={width} onCollapse={toggleChat} />
            <div
              onPointerDown={(e) => {
                drag.current = { startX: e.clientX, startW: width };
                setDragging(true);
              }}
              className="group relative z-10 w-[5px] shrink-0 cursor-col-resize"
              title="拖动调整导演台宽度"
            >
              <span
                className={`absolute inset-y-0 left-[2px] w-[0.5px] transition-colors ${
                  dragging ? "bg-[var(--accent-dim)]" : "bg-[var(--line-1)] group-hover:bg-[var(--line-3)]"
                }`}
              />
            </div>
          </>
        ) : (
          // 收起后左边留一条竖轨：别让人找不到回来的路
          <button
            onClick={toggleChat}
            title="展开导演台 (Ctrl+B)"
            className="no-select group flex w-10 shrink-0 flex-col items-center gap-2.5 border-r-[0.5px] border-[var(--line-1)] bg-[var(--bg-1)] pt-3.5 transition-colors hover:bg-[var(--bg-2)]"
          >
            <span className="text-[var(--fg-3)] transition-colors group-hover:text-[var(--fg-1)]">
              {I.panel(15)}
            </span>
            <span
              className="t-11 tracking-[0.14em] text-[var(--fg-3)] transition-colors group-hover:text-[var(--fg-1)]"
              style={{ writingMode: "vertical-rl" }}
            >
              导演台
            </span>
          </button>
        )}

        <Workspace chatOpen={chatOpen} onOpenChat={toggleChat} />
      </div>

      {!ready ? (
        <div className="fixed inset-0 grid place-items-center bg-[var(--bg-base)]">
          <div className="flex items-center gap-2.5 t-12 text-[var(--fg-3)]">
            <span className="size-1.5 rounded-full bg-[var(--accent)] dot-live" />
            正在检查环境
          </div>
        </div>
      ) : null}

      {error ? (
        <div
          role="status"
          className="fixed left-1/2 top-11 z-[60] flex max-w-[min(620px,calc(100vw-64px))] -translate-x-1/2 items-start gap-2.5 rounded-[12px] bg-[var(--bg-3)] px-3.5 py-2.5 shadow-[inset_0_0_0_0.5px_var(--line-2),0_16px_40px_-12px_rgba(0,0,0,0.8)] fade-in"
        >
          <span className="mt-[6px] size-1.5 shrink-0 rounded-full bg-[var(--err)]" />
          <span className="t-12 selectable whitespace-pre-wrap leading-[19px] text-[var(--fg-2)]">
            {error}
          </span>
          <IconBtn label="关闭提示" onClick={clearError} className="-mr-1.5 -mt-1 shrink-0">
            {I.close(12)}
          </IconBtn>
        </div>
      ) : null}

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
