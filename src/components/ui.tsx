import type { ReactNode } from "react";

/* ------------------------------------------------------------------ *
 * 基础原语：按钮 / 标签 / 加载 / 空态 / 图标
 * 只做"一套"，全应用复用；不在组件里现编 className 拼皮肤
 * ------------------------------------------------------------------ */

export const cx = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(" ");

type Variant = "ghost" | "outline" | "primary" | "accent" | "danger";
type Size = "xs" | "sm" | "md";

const SIZE: Record<Size, string> = { xs: "btn-xs", sm: "btn-sm", md: "" };
const VARIANT: Record<Variant, string> = {
  ghost: "btn-ghost",
  outline: "btn-outline",
  primary: "btn-primary",
  accent: "btn-accent",
  danger: "btn-danger btn-ghost",
};

export function Btn({
  variant = "ghost",
  size = "md",
  icon,
  children,
  className,
  ...rest
}: {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={cx("btn no-select", VARIANT[variant], SIZE[size], className)}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconBtn({
  label,
  children,
  className,
  ...rest
}: {
  label: string;
  children: ReactNode;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      title={label}
      aria-label={label}
      className={cx("icon-btn no-select", className)}
    >
      {children}
    </button>
  );
}

export function Tag({
  tone = "quiet",
  children,
  className,
}: {
  tone?: "quiet" | "accent" | "ok" | "warn" | "err";
  children: ReactNode;
  className?: string;
}) {
  return <span className={cx("tag no-select", `tag-${tone}`, className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cx("size-3.5 shrink-0 spin", className)} aria-hidden>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.22" />
      <path d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton rounded-[9px]", className)} />;
}

export function Empty({
  icon,
  title,
  desc,
  actions,
}: {
  icon?: ReactNode;
  title: string;
  desc?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="h-full min-h-[320px] grid place-items-center px-6">
      <div className="max-w-[380px] text-center fade-in">
        {icon ? (
          <div className="mx-auto mb-3.5 grid size-10 place-items-center rounded-[12px] bg-[var(--bg-2)] text-[var(--fg-3)] shadow-[inset_0_0_0_0.5px_var(--line-2)]">
            {icon}
          </div>
        ) : null}
        <div className="t-13 font-medium text-[var(--fg-2)]">{title}</div>
        {desc ? (
          <div className="mt-1.5 t-12 leading-[19px] text-[var(--fg-3)]">{desc}</div>
        ) : null}
        {actions ? <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/* ---------------- 图标：16 网格、1.5 描边、currentColor ---------------- */

const svg = (children: ReactNode, size = 14) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

export const I = {
  plus: (s?: number) => svg(<path d="M8 3.5v9M3.5 8h9" />, s),
  close: (s?: number) => svg(<path d="M4 4l8 8M12 4l-8 8" />, s),
  chevron: (s?: number) => svg(<path d="M4.5 6.5L8 10l3.5-3.5" />, s),
  chevronRight: (s?: number) => svg(<path d="M6.5 4.5L10 8l-3.5 3.5" />, s),
  play: (s?: number) => svg(<path d="M6 4.2l6 3.8-6 3.8V4.2z" fill="currentColor" stroke="none" />, s),
  send: (s?: number) => svg(<path d="M8 13V3.8M4 7.6L8 3.4l4 4.2" />, s),
  folder: (s?: number) => svg(<path d="M2.2 5.2v6.1a1 1 0 001 1h9.6a1 1 0 001-1V6.2a1 1 0 00-1-1H8L6.6 3.6h-3.4a1 1 0 00-1 1v.6z" />, s),
  edit: (s?: number) => svg(<path d="M9.6 3l3.4 3.4-7 7L2 14l.6-4L9.6 3zM11.2 4.6l-1-1M3.6 9.4l3 3" />, s),
  trash: (s?: number) => svg(<path d="M3 4.5h10M6.4 4.5V3.4a.8.8 0 01.8-.8h1.6a.8.8 0 01.8.8v1.1M4.4 4.5l.5 8a.9.9 0 00.9.8h4.4a.9.9 0 00.9-.8l.5-8" />, s),
  refresh: (s?: number) => svg(<path d="M13 8a5 5 0 11-1.6-3.7M13 2.6V5h-2.4" />, s),
  copy: (s?: number) => svg(<path d="M5.6 5.6V3.9a.9.9 0 01.9-.9h5.6a.9.9 0 01.9.9v5.6a.9.9 0 01-.9.9h-1.7M3.9 5.6h5.2a.9.9 0 01.9.9v5.2a.9.9 0 01-.9.9H3.9a.9.9 0 01-.9-.9V6.5a.9.9 0 01.9-.9z" />, s),
  check: (s?: number) => svg(<path d="M3.5 8.4l3 3 6-6.4" />, s),
  settings: (s?: number) => svg(<path d="M8 10.1a2.1 2.1 0 100-4.2 2.1 2.1 0 000 4.2zM13 8c0-.3 0-.6-.1-.9l1.1-.8-1-1.7-1.3.5a4.3 4.3 0 00-1.5-.9L10 2.8H8l-.2 1.4c-.6.2-1.1.5-1.5.9l-1.3-.5-1 1.7 1.1.8a4.4 4.4 0 000 1.8l-1.1.8 1 1.7 1.3-.5c.4.4.9.7 1.5.9l.2 1.4h2l.2-1.4c.6-.2 1.1-.5 1.5-.9l1.3.5 1-1.7-1.1-.8c.1-.3.1-.6.1-.9z" />, s),
  film: (s?: number) => svg(<path d="M2.5 4.5h11v7h-11zM5.5 4.5v7M10.5 4.5v7M2.5 8h11" />, s),
  layers: (s?: number) => svg(<path d="M8 2.5l5.5 3L8 8.5l-5.5-3 5.5-3zM2.5 8L8 11l5.5-3M2.5 10.6L8 13.6l5.5-3" />, s),
  image: (s?: number) => svg(<path d="M2.5 4.2a1 1 0 011-1h9a1 1 0 011 1v7.6a1 1 0 01-1 1h-9a1 1 0 01-1-1V4.2zM2.8 10.5l3-3 2.4 2.4 1.7-1.7 3.3 3.3" />, s),
  logs: (s?: number) => svg(<path d="M3 4h10M3 8h7M3 12h9" />, s),
  arrowLeft: (s?: number) => svg(<path d="M9.8 3.8L5.6 8l4.2 4.2" />, s),
  arrowRight: (s?: number) => svg(<path d="M6.2 3.8L10.4 8l-4.2 4.2" />, s),
  down: (s?: number) => svg(<path d="M8 3.4v9.2M4.2 8.8L8 12.6l3.8-3.8" />, s),
  spark: (s?: number) => svg(<path d="M8 2.5l1.4 3.6 3.6 1.4-3.6 1.4L8 12.5 6.6 8.9 3 7.5l3.6-1.4L8 2.5z" />, s),
  panel: (s?: number) => svg(<path d="M2.6 3.6h10.8v8.8H2.6zM6.4 3.6v8.8" />, s),
  bolt: (s?: number) => svg(<path d="M8.8 2.5L4.4 8.8h3l-.7 4.7 4.4-6.3h-3l.7-4.7z" />, s),
  node: (s?: number) => svg(<path d="M3 3.5h4v4H3zM9 8.5h4v4H9zM7 5.5h2.2a.8.8 0 01.8.8v2.2" />, s),
  dot: (s?: number) => svg(<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />, s),
};
