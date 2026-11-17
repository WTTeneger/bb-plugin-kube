// The sidebar toolbar shown while the Kubernetes panel is open.
import { useEffect, useMemo, useState } from "react";
import type { Snapshot } from "../contract";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { actions } from "./dialogs";
import { ago, Dot, Hint, NativeSelect, toneForPod, useGo, useNow, type Tone } from "./shared";
import {
  ALL,
  core,
  filters,
  useFilters,
  useKube,
  useKubeRealtime,
  usePortForwards,
  useResource,
} from "./store";
import { getLang, L, setLang } from "./i18n";

export interface SectionDef {
  id: string;
  /** A function, so the title follows the language toggle. */
  title: () => string;
  icon: string;
}

export const SECTIONS: SectionDef[] = [
  { id: "", title: () => L("Overview", "Сводка"), icon: "LayoutDashboard" },
  { id: "pods", title: () => L("Pods", "Поды"), icon: "Box" },
  { id: "deployments", title: () => L("Deployments", "Деплойменты"), icon: "Layers" },
  { id: "rollout", title: () => L("Rollout check", "Проверка выката"), icon: "RotateCcw" },
  { id: "jobs", title: () => L("Jobs & CronJobs", "Jobs и CronJobs"), icon: "Timer" },
  { id: "network", title: () => L("Services & Ingress", "Сервисы и Ingress"), icon: "Network" },
  { id: "argocd", title: () => "ArgoCD", icon: "GitBranch" },
  { id: "nodes", title: () => L("Nodes", "Ноды"), icon: "Server" },
  { id: "storage", title: () => L("Storage (PVC)", "Хранилище (PVC)"), icon: "HardDrive" },
  { id: "port-forwards", title: () => L("Port-forwards", "Проброс портов"), icon: "ArrowRightLeft" },
  { id: "events", title: () => L("Events", "События"), icon: "Activity" },
];

/** Per-namespace pod totals and problems, for the namespace picker. */
function namespaceStats(snapshot: Snapshot | null) {
  const stats = new Map<string, { pods: number; problems: number }>();
  if (!snapshot) return stats;
  for (const p of snapshot.pods) {
    const s = stats.get(p.namespace) ?? { pods: 0, problems: 0 };
    s.pods += 1;
    if (toneForPod(p) === "bad") s.problems += 1;
    stats.set(p.namespace, s);
  }
  for (const w of snapshot.workloads) {
    if (!stats.has(w.namespace)) stats.set(w.namespace, { pods: 0, problems: 0 });
    if (!w.healthy) stats.get(w.namespace)!.problems += 1;
  }
  return stats;
}

function NamespacePicker({ all, snapshot }: { all: string[]; snapshot: Snapshot | null }) {
  const f = useFilters();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const stats = useMemo(() => namespaceStats(snapshot), [snapshot]);
  const names = useMemo(() => {
    const set = new Set([...all, ...stats.keys(), ...f.namespaces]);
    return [...set].sort();
  }, [all, stats, f.namespaces]);
  const shown = names.filter((n) => n.toLowerCase().includes(search.trim().toLowerCase()));
  const toggle = (ns: string) => {
    const next = f.namespaces.includes(ns) ? f.namespaces.filter((n) => n !== ns) : [...f.namespaces, ns];
    filters.update({ namespaces: next });
  };
  const label =
    f.namespaces.length === 0
      ? L("All namespaces", "Все неймспейсы")
      : f.namespaces.length === 1
        ? f.namespaces[0]
        : L(`${f.namespaces.length} namespaces`, `неймспейсов: ${f.namespaces.length}`);
  const problemNs = names.filter((n) => (stats.get(n)?.problems ?? 0) > 0);

  return (
    <div className="min-w-0 flex-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-7 w-full items-center gap-1 rounded-md border border-input px-2 text-left text-xs hover:bg-state-hover"
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Icon name="kube-ChevronDown" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="mt-1 space-y-1 rounded-md border border-border bg-background p-1.5">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={L("Find namespace…", "Найти неймспейс…")}
            className="h-7 text-xs"
            aria-label={L("Find namespace", "Найти неймспейс")}
            autoFocus
          />
          <div className="flex flex-wrap gap-1 px-0.5">
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-state-hover hover:text-foreground"
              onClick={() => filters.update({ namespaces: [] })}
            >
              {L("All", "Все")}
            </button>
            {problemNs.length > 0 ? (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-state-hover hover:text-foreground"
                onClick={() => filters.update({ namespaces: problemNs })}
              >
                {L("With problems (", "С проблемами (")}{problemNs.length})
              </button>
            ) : null}
          </div>
          <ul className="max-h-64 overflow-y-auto" role="listbox" aria-multiselectable="true" aria-label={L("Namespaces", "Неймспейсы")}>
            {shown.map((ns) => {
              const s = stats.get(ns);
              const checked = f.namespaces.includes(ns);
              return (
                <li key={ns}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-state-hover">
                    <input type="checkbox" checked={checked} onChange={() => toggle(ns)} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-mono">{ns}</span>
                    {s && s.problems > 0 ? (
                      <span className="rounded-full bg-destructive/15 px-1.5 text-[10px] font-medium text-destructive">{s.problems}</span>
                    ) : null}
                    {s ? <span className="tabular-nums text-muted-foreground">{s.pods}</span> : null}
                  </label>
                </li>
              );
            })}
            {shown.length === 0 ? <li className="px-1.5 py-1 text-xs text-muted-foreground">{L("No match", "Ничего не найдено")}</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function useSectionCounts(snapshot: Snapshot | null) {
  const f = useFilters();
  const argo = useResource("argocd");
  const pfs = usePortForwards();
  return useMemo(() => {
    const counts: Record<string, { count: number; problems: number }> = {};
    const nsOk = (ns: string | null | undefined) => f.namespaces.length === 0 || (ns != null && f.namespaces.includes(ns));
    if (snapshot) {
      const pods = snapshot.pods.filter((p) => nsOk(p.namespace));
      const wl = snapshot.workloads.filter((w) => nsOk(w.namespace));
      const jobs = snapshot.jobs.filter((j) => nsOk(j.namespace));
      counts.pods = { count: pods.length, problems: pods.filter((p) => toneForPod(p) === "bad").length };
      counts.deployments = { count: wl.length, problems: wl.filter((w) => !w.healthy).length };
      counts.jobs = { count: jobs.length, problems: jobs.filter((j) => !j.healthy).length };
      counts.network = {
        count: snapshot.services.filter((s) => nsOk(s.namespace)).length + snapshot.ingresses.filter((i) => nsOk(i.namespace)).length,
        problems: 0,
      };
      counts.nodes = { count: snapshot.nodes.length, problems: snapshot.nodes.filter((n) => !n.ready).length };
      counts.events = { count: snapshot.events.filter((e) => e.type === "Warning" && nsOk(e.namespace)).length, problems: 0 };
    }
    if (argo.data?.installed) {
      const apps = argo.data.apps.filter((a) => nsOk(a.destNamespace));
      counts.argocd = {
        count: apps.length,
        problems: apps.filter((a) => a.sync !== "Synced" || (a.health !== "Healthy" && a.health !== "Progressing")).length,
      };
    }
    const active = pfs.filter((p) => p.status === "running" || p.status === "starting");
    counts["port-forwards"] = { count: active.length, problems: pfs.filter((p) => p.status === "error").length };
    return counts;
  }, [snapshot, f.namespaces, argo.data, pfs]);
}

export function KubeSidebar({ subPath }: { subPath: string }) {
  const { rpc, config, snapshot, error, loading } = useKube(false);
  useKubeRealtime();
  const f = useFilters();
  const go = useGo();
  const now = useNow();
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const context = config?.selection?.context ?? "";
  const section = subPath.split("/")[0] ?? "";
  const counts = useSectionCounts(snapshot);
  const pfs = usePortForwards().filter((p) => p.status === "running" || p.status === "starting");

  useEffect(() => {
    if (context) filters.loadFor(context);
  }, [context]);

  useEffect(() => {
    if (!context) return;
    let cancelled = false;
    rpc.call("namespaces", { context }).then(
      (r) => !cancelled && setNamespaces(r.namespaces),
      () => !cancelled && setNamespaces([]),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, context]);

  const issues = (counts.pods?.problems ?? 0) + (counts.deployments?.problems ?? 0);
  const health: Tone = error ? "bad" : !snapshot ? "muted" : issues > 0 ? "warn" : "good";

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 px-2 pb-2 pt-1 text-sm">
      <div className="space-y-1.5 rounded-lg border border-border bg-card p-2">
        <div className="flex items-center gap-1.5">
          <Icon name="kube-Ship" className="size-3.5 shrink-0 text-muted-foreground" />
          <NativeSelect
            className="min-w-0 flex-1"
            label={L("Kubernetes context", "Контекст Kubernetes")}
            value={context}
            onChange={(c) => void core.select(c, ALL)}
            options={(config?.contexts ?? []).map((c) => ({
              value: c,
              label: c === config?.kubeconfigCurrent ? L(`${c} (current)`, `${c} (текущий)`) : c,
            }))}
          />
        </div>
        <div className="flex items-start gap-1.5">
          <Icon name="kube-FolderTree" className="mt-1.5 size-3.5 shrink-0 text-muted-foreground" />
          <NamespacePicker all={namespaces} snapshot={snapshot} />
        </div>
        <div className="relative">
          <Icon name="kube-Search" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={f.query}
            onChange={(e) => filters.update({ query: e.target.value })}
            placeholder={L("Search by name…", "Поиск по имени…")}
            className="h-7 pl-7 text-xs"
            aria-label={L("Search all resources by name", "Поиск по имени во всех разделах")}
          />
        </div>
        <div className="flex items-center gap-1.5 pl-0.5 text-xs text-muted-foreground">
          <Dot tone={health} />
          <span className="min-w-0 flex-1 truncate" title={error ?? undefined}>
            {error
              ? L("Unreachable", "Нет связи")
              : snapshot
                ? L(`${issues > 0 ? `${issues} issues` : "Healthy"} · ${ago(snapshot.fetchedAt, now)} ago`, `${issues > 0 ? `проблем: ${issues}` : "Всё в порядке"} · ${ago(snapshot.fetchedAt, now)} назад`)
                : L("Loading…", "Загрузка…")}
          </span>
          <Hint label={L("Interface language: switch to Russian", "Язык интерфейса: переключить на английский")}>
            <button
              type="button"
              className="rounded border border-border px-1 text-[10px] font-medium uppercase tracking-wide hover:bg-state-hover hover:text-foreground"
              aria-label={L("Switch interface language", "Сменить язык интерфейса")}
              onClick={async () => {
                const next = getLang() === "ru" ? "en" : "ru";
                setLang(next);
                await rpc.call("set_language", { language: next });
                void core.refresh({ config: true });
              }}
            >
              {getLang() === "ru" ? "RU" : "EN"}
            </button>
          </Hint>
          {config?.readOnly ? (
            <Hint label={L("Read-only mode: restarts, scaling and syncs are hidden. Change it in the plugin settings.", "Режим только для чтения: перезапуски, масштабирование и синхронизации скрыты. Меняется в настройках плагина.")}>
              <span className="rounded border border-border px-1 text-[10px] uppercase tracking-wide">RO</span>
            </Hint>
          ) : null}
          <Hint label={L("Refresh cluster state now", "Обновить состояние кластера")}>
            <button
              type="button"
              className="rounded p-0.5 hover:bg-state-hover hover:text-foreground"
              aria-label={L("Refresh", "Обновить")}
              onClick={() => void core.refresh({ force: true })}
            >
              <Icon name="kube-RefreshCw" className={cn("size-3.5", loading && "animate-spin")} />
            </button>
          </Hint>
        </div>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto" aria-label={L("Kubernetes sections", "Разделы Kubernetes")}>
        {SECTIONS.map((s) => {
          const active = section === s.id;
          const c = counts[s.id];
          return (
            <button
              key={s.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => go(s.id)}
              className={cn(
                "flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground",
                active && "bg-state-active text-foreground",
              )}
            >
              <Icon name={`kube-${s.icon}`} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{s.title()}</span>
              {c && c.problems > 0 ? (
                <span className="rounded-full bg-destructive/15 px-1.5 text-[11px] font-medium text-destructive">{c.problems}</span>
              ) : null}
              {c && c.count > 0 ? <span className="text-xs tabular-nums">{c.count}</span> : null}
            </button>
          );
        })}

        {pfs.length > 0 ? (
          <div className="mt-3 space-y-1 border-t border-border pt-2">
            <div className="px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{L("Forwarding", "Проброшено")}</div>
            {pfs.map((p) => (
              <div key={p.id} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-state-hover">
                <Dot tone={p.status === "running" ? "good" : "warn"} />
                <Hint label={`${L("Open", "Открыть")} http://localhost:${p.localPort ?? "…"} → ${p.namespace}/${p.kind}/${p.name}:${p.remotePort} (${p.context})`} side="right">
                  <a
                    href={p.localPort ? `http://localhost:${p.localPort}` : undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 flex-1 truncate font-mono hover:underline"
                  >
                    :{p.localPort ?? "…"} → {p.name}:{p.remotePort}
                  </a>
                </Hint>
                <Hint label={L("Stop this port-forward", "Остановить проброс порта")} side="right">
                  <button
                    type="button"
                    aria-label={L(`Stop port-forward ${p.name}:${p.remotePort}`, `Остановить проброс ${p.name}:${p.remotePort}`)}
                    className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                    onClick={() => void actions.stopPortForward(p.id)}
                  >
                    <Icon name="kube-Square" className="size-3" />
                  </button>
                </Hint>
              </div>
            ))}
          </div>
        ) : null}
      </nav>
    </div>
  );
}
