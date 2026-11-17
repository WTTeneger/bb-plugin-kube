// Small presentational pieces shared by every section.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Pod } from "../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { filters, useFilters } from "./store";
import { L } from "./i18n";

export const PANEL_PATH = "kubernetes";

export function useGo() {
  const navigate = useBbNavigate();
  return (section: string) => navigate.toPluginPanel(PANEL_PATH, { subPath: section });
}

// ---- formatting ----------------------------------------------------------------

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return L(`${s}s`, `${s}с`);
  const m = Math.floor(s / 60);
  if (m < 60) return L(`${m}m`, `${m}м`);
  const h = Math.floor(m / 60);
  if (h < 48) return L(`${h}h`, `${h}ч`);
  return L(`${Math.floor(h / 24)}d`, `${Math.floor(h / 24)}д`);
}

export function useNow(ms = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function fmtCpu(milli: number | null | undefined): string {
  if (milli === null || milli === undefined) return "—";
  if (milli >= 1000) return `${(milli / 1000).toFixed(milli >= 10_000 ? 0 : 1)}`;
  return `${Math.round(milli)}m`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "Ki", "Mi", "Gi", "Ti", "Pi"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

export function pct(part: number | null | undefined, whole: number | null | undefined): number | null {
  if (part === null || part === undefined || !whole) return null;
  return (part / whole) * 100;
}

export function fmtPct(p: number | null): string {
  return p === null ? "—" : `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

// ---- tones ----------------------------------------------------------------------

export type Tone = "good" | "warn" | "bad" | "muted" | "info";

export function isRecent(iso: string | null, hours = 1): boolean {
  return iso !== null && Date.now() - Date.parse(iso) < hours * 3600_000;
}

export function toneForPod(p: Pod): Tone {
  if (p.phase === "Succeeded") return "muted";
  if (p.healthy) return p.restarts > 0 && isRecent(p.lastRestartAt) ? "warn" : "good";
  if (p.phase === "Pending" || p.status === "ContainerCreating" || p.status === "Terminating") return "warn";
  return "bad";
}

export function toneForUsage(p: number | null): Tone {
  if (p === null) return "muted";
  if (p >= 90) return "bad";
  if (p >= 75) return "warn";
  return "good";
}

export const dotClass: Record<Tone, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  muted: "bg-muted-foreground/50",
  info: "bg-sky-500",
};
export const textClass: Record<Tone, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-destructive",
  muted: "text-muted-foreground",
  info: "text-sky-600 dark:text-sky-400",
};

export function Dot({ tone }: { tone: Tone }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", dotClass[tone])} />;
}

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium", textClass[tone])}>
      <Dot tone={tone} />
      {children}
    </span>
  );
}

export function Chip({ children, tone = "muted", title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded border px-1.5 py-px text-[11px] leading-4",
        tone === "muted" ? "border-border text-muted-foreground" : cn("border-current/30", textClass[tone]),
      )}
    >
      {children}
    </span>
  );
}

// ---- layout ---------------------------------------------------------------------

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function ErrorBox({ title, error, onRetry }: { title: string; error: string; onRetry?: () => void }) {
  return (
    <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
      <p className="font-medium text-destructive">{title}</p>
      <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">{error}</pre>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {L("Retry", "Повторить")}
        </Button>
      ) : null}
    </div>
  );
}

export function SectionCard({ title, children, action }: { title: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="flex min-h-10 items-center gap-2 border-b border-border px-3 py-1.5">
        <h2 className="flex-1 text-sm font-medium">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Metric({
  label,
  value,
  note,
  tone,
  onClick,
  children,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: Tone;
  onClick?: () => void;
  children?: ReactNode;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn("rounded-lg border border-border bg-card p-3 text-left", onClick && "hover:bg-state-hover")}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", tone && tone !== "good" && textClass[tone])}>{value}</div>
      {note ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{note}</div> : null}
      {children}
    </Comp>
  );
}

/** Horizontal usage bar: a filled part, an optional marker (e.g. requests). */
export function UsageBar({
  value,
  marker,
  className,
}: {
  value: number | null;
  marker?: number | null;
  className?: string;
}) {
  const v = value === null ? 0 : Math.min(100, Math.max(0, value));
  return (
    <div className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className={cn("h-full", dotClass[toneForUsage(value)])} style={{ width: `${v}%` }} />
      {marker !== null && marker !== undefined ? (
        <div
          className="absolute inset-y-0 w-0.5 bg-foreground/70"
          style={{ left: `calc(${Math.min(100, Math.max(0, marker))}% - 1px)` }}
        />
      ) : null}
    </div>
  );
}

export function UsageRow({
  label,
  used,
  requested,
  total,
  fmt,
}: {
  label: string;
  used: number | null;
  requested: number;
  total: number;
  fmt: (n: number | null) => string;
}) {
  const usedPct = pct(used, total);
  const reqPct = pct(requested, total);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
        <span className={cn("font-medium tabular-nums", textClass[toneForUsage(usedPct)])}>{fmtPct(usedPct)}</span>
        <span className="min-w-0 flex-1 truncate text-right tabular-nums text-muted-foreground">
          {fmt(used)} {L("used ·", "занято ·")} {fmt(requested)} {L("req (", "запрошено (")}{fmtPct(reqPct)}) / {fmt(total)}
        </span>
      </div>
      <UsageBar value={usedPct} marker={reqPct} />
    </div>
  );
}

// ---- controls ---------------------------------------------------------------------

/** Hover/focus tooltip that says what a control does. */
export function Hint({ label, children, side = "top" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TooltipProvider delayDuration={150} skipDelayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} className="max-w-xs text-xs">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Small labelled action: visible text, not just an icon. */
export function ActionButton({
  icon,
  label,
  hint,
  onClick,
  disabled,
  danger,
  hideLabelBelow,
}: {
  icon: string;
  label: string;
  /** What the button does, shown on hover. Defaults to the label. */
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  hideLabelBelow?: "xl" | "2xl" | "wide";
}) {
  const button = (
    <Button
      variant="outline"
      size="sm"
      aria-label={label}
      className={cn(
        "h-7 gap-1 px-2 text-xs font-normal",
        danger && "hover:border-destructive/50 hover:text-destructive",
      )}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={`kube-${icon}`} className="size-3.5" />
      <span className={cn(hideLabelBelow === "xl" && "hidden xl:inline", hideLabelBelow === "2xl" && "hidden 2xl:inline", hideLabelBelow === "wide" && "hidden min-[1800px]:inline")}>
        {label}
      </span>
    </Button>
  );
  // A disabled button gets no pointer events: hang the hint on a wrapper.
  return <Hint label={hint ?? label}>{disabled ? <span className="inline-flex">{button}</span> : button}</Hint>;
}

export function IconButton({
  icon,
  label,
  hint,
  onClick,
  disabled,
  danger,
}: {
  icon: string;
  /** Short accessible name, e.g. "Describe". */
  label: string;
  /** What it does, shown on hover. Defaults to the label. */
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Hint label={hint ?? label}>
    <span className="inline-flex">
      <Button
        variant="ghost"
        size="icon"
        className={cn("size-7 text-muted-foreground hover:text-foreground", danger && "hover:text-destructive")}
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
      >
        <Icon name={`kube-${icon}`} className="size-3.5" />
      </Button>
    </span>
    </Hint>
  );
}

export function Toggle({ value, onChange, children }: { value: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <Button variant="outline" size="sm" aria-pressed={value} className="h-8 aria-pressed:bg-state-active" onClick={() => onChange(!value)}>
      {children}
    </Button>
  );
}

export function NativeSelect({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-full cursor-pointer appearance-none truncate rounded-md border border-input bg-transparent pl-2 pr-6 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="kube-ChevronDown" className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

/**
 * The bar above every list: name search (shared across sections), active
 * namespace / pivot chips, section-specific toggles, and the count.
 */
export function FilterBar({ count, total, children }: { count: number; total?: number; children?: ReactNode }) {
  const f = useFilters();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Icon name="kube-Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={f.query}
            onChange={(e) => filters.update({ query: e.target.value })}
            placeholder={L("Search by name…", "Поиск по имени…")}
            className="h-8 pl-8 pr-7 text-xs"
            aria-label={L("Search by name", "Поиск по имени")}
            data-kube-search
          />
          {f.query ? (
            <Hint label={L("Clear search", "Очистить поиск")}>
            <button
              type="button"
              aria-label={L("Clear search", "Очистить поиск")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => filters.update({ query: "" })}
            >
              <Icon name="kube-X" className="size-3.5" />
            </button>
            </Hint>
          ) : null}
        </div>
        {children}
        <div className="flex-1" />
        <span className="text-xs tabular-nums text-muted-foreground">
          {total !== undefined && total !== count ? L(`${count} of ${total}`, `${count} из ${total}`) : L(`${count} shown`, `показано: ${count}`)}
        </span>
      </div>
      <ActiveFilterChips />
    </div>
  );
}

function RemovableChip({ label, onRemove }: { label: ReactNode; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 py-0.5 pl-2 pr-1 text-xs">
      {label}
      <Hint label={L("Remove this filter", "Убрать этот фильтр")}>
        <button type="button" aria-label={L("Remove filter", "Убрать фильтр")} className="rounded-full p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={onRemove}>
          <Icon name="kube-X" className="size-3" />
        </button>
      </Hint>
    </span>
  );
}

export function ActiveFilterChips() {
  const f = useFilters();
  if (f.namespaces.length === 0 && !f.workload && !f.node) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {f.namespaces.map((ns) => (
        <RemovableChip
          key={ns}
          label={
            <>
              <span className="text-muted-foreground">ns</span> <span className="font-mono">{ns}</span>
            </>
          }
          onRemove={() => filters.update({ namespaces: f.namespaces.filter((n) => n !== ns) })}
        />
      ))}
      {f.workload ? (
        <RemovableChip
          label={
            <>
              <span className="text-muted-foreground">{f.workload.kind}</span>{" "}
              <span className="font-mono">{f.workload.namespace}/{f.workload.name}</span>
            </>
          }
          onRemove={() => filters.update({ workload: null })}
        />
      ) : null}
      {f.node ? (
        <RemovableChip
          label={
            <>
              <span className="text-muted-foreground">{L("node", "нода")}</span> <span className="font-mono">{f.node}</span>
            </>
          }
          onRemove={() => filters.update({ node: null })}
        />
      ) : null}
      <button
        type="button"
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        onClick={() => filters.update({ namespaces: [], workload: null, node: null, query: "" })}
      >
        {L("Clear all", "Сбросить всё")}
      </button>
    </div>
  );
}

export const th = "px-2.5 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap";
export const td = "px-2.5 py-1.5 align-middle";

export function NameCell({ name, sub, className, title }: { name: string; sub?: ReactNode; className?: string; title?: string }) {
  return (
    <td className={cn(td, "max-w-[320px]", className)}>
      <div className="truncate font-mono text-xs" title={title ?? name}>
        {name}
      </div>
      {sub ? <div className="truncate text-[11px] text-muted-foreground">{sub}</div> : null}
    </td>
  );
}
