import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { I, cx } from "./ui";

/**
 * 顶栏的项目切换器：项目 = 磁盘上的工程文件夹（画布 + 多条会话都在里面）。
 * 切换 / 新建 / 重命名 / 删除 / 打开文件夹，全在这一颗按钮里。
 */
export function ProjectSwitcher() {
  const {
    projects,
    project,
    busy,
    openProject,
    createProject,
    deleteProject,
    renameProject,
    openProjectFolder,
    refreshProjects,
  } = useStore();

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open]);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const submitCreate = () => {
    const name = draftName.trim();
    if (!name) return;
    setCreating(false);
    setDraftName("");
    void createProject(name);
  };

  const submitRename = () => {
    const id = renaming;
    const name = renameText.trim();
    if (!id || !name) {
      setRenaming(null);
      return;
    }
    setRenaming(null);
    void renameProject(id, name);
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void refreshProjects();
        }}
        className="flex max-w-[240px] items-center gap-1.5 rounded-[7px] px-1.5 py-1 transition-colors hover:bg-[var(--bg-2)]"
        title={project ? `当前项目：${project.name}（${project.path}）` : "选择项目"}
      >
        <span className="text-[var(--fg-3)]">{I.folder(13)}</span>
        <span className="t-12 truncate text-[var(--fg-1)]">
          {project ? project.name : "选择项目"}
        </span>
        <span
          className={cx(
            "text-[var(--fg-4)] transition-transform",
            open ? "rotate-90" : ""
          )}
        >
          {I.chevronRight(10)}
        </span>
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-[300px] rounded-[12px] border-[0.5px] border-[var(--line-1)] bg-[var(--bg-1)] p-1.5 shadow-2xl fade-in">
          <div className="px-2 pb-1 pt-1.5 t-11 text-[var(--fg-4)]">
            项目 · 存在磁盘上，一个项目一个文件夹
          </div>

          <div className="max-h-[280px] overflow-y-auto">
            {projects.map((p) => {
              const active = p.id === project?.id;
              return (
                <div
                  key={p.id}
                  className={cx(
                    "group flex items-center gap-1 rounded-[8px] px-2 py-[7px] transition-colors",
                    active ? "bg-[var(--bg-3)]" : "hover:bg-[var(--bg-2)]"
                  )}
                >
                  {renaming === p.id ? (
                    <input
                      autoFocus
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitRename();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={submitRename}
                      className="min-w-0 flex-1 rounded-[6px] bg-[var(--bg-base)] px-1.5 py-0.5 t-12 text-[var(--fg-1)] outline-[0.5px] outline-[var(--accent)]"
                    />
                  ) : (
                    <>
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => {
                          setOpen(false);
                          if (!active) void openProject(p.id);
                        }}
                        title={p.path}
                      >
                        <span
                          className={cx(
                            "block truncate t-12",
                            active ? "font-medium text-[var(--fg-1)]" : "text-[var(--fg-2)]"
                          )}
                        >
                          {p.name}
                        </span>
                        <span className="t-11 tabular text-[var(--fg-4)]">
                          {active ? "当前项目" : new Date(p.updatedAt).toLocaleDateString("zh-CN")}
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          className="grid size-6 place-items-center rounded-[6px] text-[var(--fg-4)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-1)]"
                          title="重命名"
                          onClick={() => {
                            setRenaming(p.id);
                            setRenameText(p.name);
                          }}
                        >
                          {I.edit(12)}
                        </button>
                        <button
                          className="grid size-6 place-items-center rounded-[6px] text-[var(--fg-4)] hover:bg-[var(--bg-3)] hover:text-[var(--err)]"
                          title={confirmDel === p.id ? "再点一次确认删除" : "删除项目（文件夹一并删除）"}
                          onClick={() => {
                            if (confirmDel === p.id) {
                              setConfirmDel(null);
                              void deleteProject(p.id);
                            } else {
                              setConfirmDel(p.id);
                              setTimeout(() => setConfirmDel((c) => (c === p.id ? null : c)), 2500);
                            }
                          }}
                        >
                          {I.close(12)}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {creating ? (
            <div className="mt-1 px-1 pb-0.5">
              <input
                ref={inputRef}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCreate();
                  if (e.key === "Escape") setCreating(false);
                }}
                placeholder="项目名，回车创建"
                className="w-full rounded-[8px] bg-[var(--bg-base)] px-2 py-1.5 t-12 text-[var(--fg-1)] outline-[0.5px] outline-[var(--accent)]"
              />
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="mt-1 flex w-full items-center gap-1.5 rounded-[8px] px-2 py-[7px] t-12 text-[var(--fg-2)] transition-colors hover:bg-[var(--bg-2)]"
            >
              <span>{I.plus(12)}</span> 新建项目
            </button>
          )}

          {project?.path ? (
            <button
              onClick={() => {
                setOpen(false);
                void openProjectFolder();
              }}
              className="mt-0.5 flex w-full items-center gap-1.5 rounded-[8px] px-2 py-[7px] t-12 text-[var(--fg-3)] transition-colors hover:bg-[var(--bg-2)]"
              title={project.path}
            >
              <span>{I.folder(12)}</span> 打开项目文件夹
            </button>
          ) : null}

          {busy ? (
            <div className="px-2 pb-1 pt-1 t-11 text-[var(--accent)]">
              正在生成，切换/删除等这轮结束再操作
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
