// The panel page, its header actions, the sidebar badge and the overview.
import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import type { ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { actions, DialogHost } from "./dialogs";
import {
  ago,
  ActiveFilterChips,
  Dot,
  EmptyState,
  ErrorBox,
  fmtBytes,
  Hint,
  fmtPct,
  IconButton,
  Metric,
  pct,
  SectionCard,
  StatusPill,
  toneForPod,
  UsageBar,
  useGo,
  useNow,
} from "./shared";
import { core, filters, useKube, useKubeRealtime, useMatchers, useResource } from "./store";
import type { Pod, Workload } from "../contract";
import { appHasProblem, ArgoSection, healthTone, syncTone } from "./sections/argocd";
import { EventList, EventsSection, JobsSection, NetworkSection, PortForwardsSection } from "./sections/misc";
import { computeNodeStats, NodesSection } from "./sections/nodes";
import { RolloutSection } from "./sections/rollout";
import { StorageSection, usedPct } from "./sections/storage";
import {
  DeploymentsSection,
  filterPods,
  PodsSection,
  PodTable,
  WorkloadTable,
  type SectionProps,
} from "./sections/workloads";
import { L } from "./i18n";

// ---------------------------------------------------------------------------
// Recently updated workloads
// ---------------------------------------------------------------------------

interface RecentItem {
  w: Workload;
  at: string;
  pods: Pod[];
}

/**
 * Workloads by their last rollout: Deployments by Progressing.lastUpdateTime,
 * StatefulSets and DaemonSets (no such condition) by their newest pod.
 */
function recentWorkloads(workloads: Workload[], pods: Pod[]): RecentItem[] {
  const byWorkload = new Map<string, Pod[]>();
  for (const p of pods) {
    if (!p.workload) continue;
    const key = `${p.workload.kind}/${p.namespace}/${p.workload.name}`;
    byWorkload.set(key, [...(byWorkload.get(key) ?? []), p]);
  }
  return workloads
    .map((w) => {
      const ps = byWorkload.get(`${w.kind}/${w.namespace}/${w.name}`) ?? [];
      const newestPod = ps.map((p) => p.createdAt).sort().at(-1) ?? null;
      return { w, pods: ps, at: w.updatedAt ?? newestPod ?? "" };
    })
    .filter((x) => x.at)
    .sort((a, b) => b.at.localeCompare(a.at));
}

function RecentlyUpdated({ items }: { items: RecentItem[] }) {
  const go = useGo();
  const now = useNow(10_000);
  const showPods = (w: Workload) => {
    filters.update({ workload: { namespace: w.namespace, kind: w.kind, name: w.name } });
    go("pods");
  };
  return (
    <SectionCard
      title={L("Recently updated", "Последние обновлённые")}
      action={<IconButton icon="ChevronRight" label={L("All deployments", "Все деплойменты")} hint={L("Open Deployments", "Открыть деплойменты")} onClick={() => go("deployments")} />}
    >
      {items.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">{L("No rollouts found.", "Выкатов не найдено.")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map(({ w, at }) => {
            const tone = !w.healthy ? "bad" : w.progressing ? "info" : "good";
            const image = w.images[0]?.split("/").at(-1) ?? "";
            return (
              <li key={`${w.kind}/${w.namespace}/${w.name}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <Hint label={!w.healthy ? L(`Not healthy: ${w.ready}/${w.desired} ready`, `Не готов: ${w.ready}/${w.desired}`) : w.progressing ? L("Rolling out now", "Сейчас выкатывается") : L("Rolled out and available", "Выкачен и доступен")}>
                  <span className="inline-flex">
                    <Dot tone={tone} />
                  </span>
                </Hint>
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => showPods(w)}
                  title={`${w.namespace}/${w.name}\n${w.images.join("\n")}`}
                >
                  <div className="truncate font-mono hover:underline">{w.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {w.namespace} · {w.kind === "Deployment" ? "" : `${w.kind} · `}
                    {image}
                  </div>
                </button>
                {w.revision ? (
                  <Hint label={w.kind === "Deployment" ? L("Deployment revision", "Ревизия деплоймента") : w.kind === "StatefulSet" ? L("StatefulSet revision hash", "Хеш ревизии StatefulSet") : L("DaemonSet generation", "Поколение DaemonSet")}>
                    <span className="w-14 truncate text-right tabular-nums text-muted-foreground">rev {w.revision}</span>
                  </Hint>
                ) : null}
                <span className="w-10 text-right font-mono tabular-nums">
                  {w.ready}/{w.desired}
                </span>
                <Hint label={L(`Updated ${new Date(at).toLocaleString()}`, `Обновлён ${new Date(at).toLocaleString()}`)}>
                  <span className="w-10 text-right tabular-nums text-muted-foreground">{ago(at, now)}</span>
                </Hint>
                <IconButton icon="ScrollText" label={L("Logs", "Логи")} hint={L("Logs from all its pods, merged by time", "Логи всех его подов, по времени")} disabled={!w.selector} onClick={() => actions.workloadLogs(w)} />
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function Overview({ snapshot, readOnly }: SectionProps) {
  const go = useGo();
  const m = useMatchers();
  const metrics = useResource("metrics");
  const argo = useResource("argocd");
  const storage = useResource("storage");

  const pods = filterPods(snapshot.pods, m);
  const workloads = snapshot.workloads.filter((w) => m.ns(w.namespace) && m.text(`${w.namespace}/${w.name}`));
  const running = pods.filter((p) => p.phase === "Running").length;
  const badPods = pods.filter((p) => toneForPod(p) === "bad");
  const pendingPods = pods.filter((p) => toneForPod(p) === "warn" && !p.healthy);
  const badWl = workloads.filter((w) => !w.healthy);
  const warnings = snapshot.events.filter((e) => e.type === "Warning" && m.ns(e.namespace));
  const restarted = [...pods]
    .filter((p) => p.restarts > 0)
    .sort((a, b) => (b.lastRestartAt ?? "").localeCompare(a.lastRestartAt ?? ""))
    .slice(0, 8);
  const problemPods = [...badPods, ...pendingPods];
  const recentlyUpdated = useMemo(() => recentWorkloads(workloads, snapshot.pods).slice(0, 10), [workloads, snapshot.pods]);

  const nodeStats = useMemo(() => computeNodeStats(snapshot.nodes, snapshot.pods, metrics.data), [snapshot, metrics.data]);
  const cpuAlloc = nodeStats.reduce((a, s) => a + s.node.cpuAllocatable, 0);
  const memAlloc = nodeStats.reduce((a, s) => a + s.node.memAllocatable, 0);
  const cpuUsed = metrics.data?.available ? nodeStats.reduce((a, s) => a + (s.cpuUsed ?? 0), 0) : null;
  const memUsed = metrics.data?.available ? nodeStats.reduce((a, s) => a + (s.memUsed ?? 0), 0) : null;
  const readyNodes = snapshot.nodes.filter((n) => n.ready).length;

  const argoApps = argo.data?.installed ? argo.data.apps.filter((a) => m.ns(a.destNamespace) || m.ns(a.namespace)) : [];
  const argoProblems = argoApps.filter(appHasProblem);
  const fullPvcs = (storage.data?.pvcs ?? [])
    .filter((p) => m.ns(p.namespace) && (usedPct(p) ?? 0) >= 80)
    .sort((a, b) => (usedPct(b) ?? 0) - (usedPct(a) ?? 0));

  return (
    <>
      <ActiveFilterChips />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Metric
          label={L("Pods running", "Поды работают")}
          value={`${running}/${pods.length}`}
          note={problemPods.length ? L(`${badPods.length} failing, ${pendingPods.length} pending`, `падают: ${badPods.length}, ждут: ${pendingPods.length}`) : L("all healthy", "все в порядке")}
          tone={badPods.length ? "bad" : pendingPods.length ? "warn" : "good"}
          onClick={() => go("pods")}
        />
        <Metric
          label={L("Deployments ready", "Деплойменты готовы")}
          value={`${workloads.length - badWl.length}/${workloads.length}`}
          note={badWl.length ? L(`${badWl.length} degraded`, `деградировали: ${badWl.length}`) : L("all available", "все доступны")}
          tone={badWl.length ? "bad" : "good"}
          onClick={() => go("deployments")}
        />
        <Metric
          label={L("Nodes", "Ноды")}
          value={`${readyNodes}/${snapshot.nodes.length}`}
          tone={readyNodes < snapshot.nodes.length ? "bad" : "good"}
          note={L(`CPU ${fmtPct(pct(cpuUsed, cpuAlloc))} · mem ${fmtPct(pct(memUsed, memAlloc))}`, `CPU ${fmtPct(pct(cpuUsed, cpuAlloc))} · память ${fmtPct(pct(memUsed, memAlloc))}`)}
          onClick={() => go("nodes")}
        >
          <div className="mt-2 space-y-1">
            <UsageBar value={pct(cpuUsed, cpuAlloc)} />
            <UsageBar value={pct(memUsed, memAlloc)} />
          </div>
        </Metric>
        <Metric
          label="ArgoCD"
          value={argo.data?.installed ? `${argoApps.length - argoProblems.length}/${argoApps.length}` : "—"}
          note={argo.data?.installed ? (argoProblems.length ? L(`${argoProblems.length} out of sync or unhealthy`, `проблемных: ${argoProblems.length}`) : L("all synced & healthy", "всё синхронно и здорово")) : argo.data ? L("not installed", "не установлен") : L("loading…", "загрузка…")}
          tone={argoProblems.length ? "warn" : argo.data?.installed ? "good" : undefined}
          onClick={() => go("argocd")}
        />
        <Metric
          label={L("PVC ≥ 80% full", "PVC заполнены ≥ 80%")}
          value={storage.data ? fullPvcs.length : "—"}
          note={fullPvcs[0] ? `${fullPvcs[0].name} ${fmtPct(usedPct(fullPvcs[0]))}` : storage.data ? L(`${storage.data.pvcs.length} claims`, `всего PVC: ${storage.data.pvcs.length}`) : L("loading…", "загрузка…")}
          tone={fullPvcs.some((p) => (usedPct(p) ?? 0) >= 90) ? "bad" : fullPvcs.length ? "warn" : storage.data ? "good" : undefined}
          onClick={() => go("storage")}
        />
        <Metric
          label={L("Warning events", "Предупреждения")}
          value={warnings.length}
          note={warnings[0] ? L(`latest: ${warnings[0].reason}`, `последнее: ${warnings[0].reason}`) : undefined}
          tone={warnings.length ? "warn" : "good"}
          onClick={() => go("events")}
        />
      </div>

      <SectionCard title={L(`Problem pods (${problemPods.length})`, `Проблемные поды (${problemPods.length})`)}>
        {problemPods.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{L("No failing or pending pods.", "Нет упавших или ждущих подов.")}</p>
        ) : (
          <PodTable pods={problemPods.slice(0, 25)} readOnly={readOnly} metrics={metrics.data} />
        )}
      </SectionCard>

      {badWl.length > 0 ? (
        <SectionCard title={L(`Degraded deployments (${badWl.length})`, `Деградировавшие деплойменты (${badWl.length})`)}>
          <WorkloadTable workloads={badWl} pods={snapshot.pods} readOnly={readOnly} metrics={metrics.data} />
        </SectionCard>
      ) : null}

      {argoProblems.length > 0 ? (
        <SectionCard title={L(`ArgoCD needs attention (${argoProblems.length})`, `ArgoCD: требует внимания (${argoProblems.length})`)} action={<IconButton icon="ChevronRight" label={L("Open ArgoCD", "Открыть ArgoCD")} hint={L("Open the ArgoCD section", "Открыть раздел ArgoCD")} onClick={() => go("argocd")} />}>
          <ul className="divide-y divide-border">
            {argoProblems.slice(0, 8).map((a) => (
              <li key={`${a.namespace}/${a.name}`} className="flex items-center gap-3 px-3 py-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono">{a.name}</span>
                <StatusPill tone={syncTone(a.sync)}>{a.sync}</StatusPill>
                <StatusPill tone={healthTone(a.health)}>{a.health}</StatusPill>
                <IconButton icon="RefreshCw" label={L("Refresh", "Обновить")} hint={L("Refresh: re-compare git with the cluster; changes nothing", "Обновить: заново сравнить git с кластером, ничего не меняет")} onClick={() => void actions.argoRefresh(a, false)} />
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="space-y-4">
        <RecentlyUpdated items={recentlyUpdated} />
        <SectionCard title={L("Recent restarts", "Последние перезапуски")}>
          {restarted.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">{L("No container restarts.", "Перезапусков контейнеров нет.")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {restarted.map((p) => (
                <li key={`${p.namespace}/${p.name}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  <Dot tone={toneForPod(p)} />
                  <span className="min-w-0 flex-1 truncate font-mono" title={`${p.namespace}/${p.name}`}>
                    {p.name}
                  </span>
                  <span className="tabular-nums text-muted-foreground">×{p.restarts}</span>
                  <span className="w-10 text-right tabular-nums text-muted-foreground">{ago(p.lastRestartAt)}</span>
                  <IconButton icon="ScrollText" label={L("Logs", "Логи")} hint={L("Show this pod's logs", "Показать логи пода")} onClick={() => actions.podLogs(p)} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        </div>
        <SectionCard title={L("Latest warnings", "Последние предупреждения")}>
          <EventList events={warnings.slice(0, 8)} compact />
        </SectionCard>
      </div>

      {fullPvcs.length > 0 ? (
        <SectionCard title={L("Volumes filling up", "Тома заполняются")}>
          <ul className="divide-y divide-border">
            {fullPvcs.slice(0, 6).map((p) => (
              <li key={`${p.namespace}/${p.name}`} className="flex items-center gap-3 px-3 py-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono">
                  {p.name} <span className="text-muted-foreground">{p.namespace}</span>
                </span>
                <UsageBar value={usedPct(p)} className="w-32" />
                <span className="w-32 text-right tabular-nums text-muted-foreground">
                  {fmtBytes(p.usedBytes)} / {fmtBytes(p.capacityBytes)}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const SECTION_VIEWS: Record<string, (p: SectionProps) => ReactNode> = {
  "": Overview,
  pods: PodsSection,
  deployments: DeploymentsSection,
  workloads: DeploymentsSection, // old links
  jobs: JobsSection,
  network: NetworkSection,
  argocd: ArgoSection,
  nodes: NodesSection,
  storage: StorageSection,
  "port-forwards": PortForwardsSection,
  rollout: RolloutSection,
  events: EventsSection,
};

export function KubePage({ subPath }: { subPath: string }) {
  const { config, snapshot, error } = useKube(true);
  useKubeRealtime();
  const section = subPath.split("/")[0] ?? "";
  const View = SECTION_VIEWS[section] ?? Overview;
  const readOnly = config?.readOnly ?? true;

  // "/" focuses the search box, like most list UIs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || t?.closest("input, textarea, select, [contenteditable]")) return;
      const box = document.querySelector<HTMLInputElement>("[data-kube-search]");
      if (box) {
        e.preventDefault();
        box.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  let body: ReactNode;
  if (!snapshot) {
    body = error ? (
      <ErrorBox title={L("Can't reach the cluster", "Нет связи с кластером")} error={error} onRetry={() => void core.refresh({ force: true, config: true })} />
    ) : (
      <EmptyState>{L("Loading cluster state…", "Загрузка состояния кластера…")}</EmptyState>
    );
  } else {
    body = <View snapshot={snapshot} readOnly={readOnly} />;
  }

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-[1400px] space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        {snapshot && error ? (
          <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {L("Last refresh failed, showing data from", "Последнее обновление не удалось, данные")} {ago(snapshot.fetchedAt)} {L("ago:", "назад:")} {error}
          </p>
        ) : null}
        {snapshot && snapshot.errors.length > 0 ? (
          <details className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">{L(`${snapshot.errors.length} resource types could not be read`, `Не удалось прочитать типов ресурсов: ${snapshot.errors.length}`)}</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono">
              {snapshot.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {body}
      </div>
      <DialogHost />
    </div>
  );
}

export function KubeHeader() {
  const { snapshot, loading } = useKube(false);
  if (!snapshot) return null;
  const { context, namespace } = snapshot.selection;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="hidden max-w-[360px] truncate font-mono sm:inline" title={context}>
        {context} · {namespace === "*" ? L("all namespaces", "все неймспейсы") : namespace}
      </span>
      <Hint label={L("Refresh cluster state now", "Обновить состояние кластера")} side="bottom">
        <Button variant="ghost" size="sm" onClick={() => void core.refresh({ force: true })} aria-label={L("Refresh", "Обновить")}>
          <Icon name="kube-RefreshCw" className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </Hint>
    </div>
  );
}

export function useKubeBadge(): ExperimentalBadge | null {
  const { snapshot, error, config } = useKube(false);
  if (error && !snapshot && config?.selection) {
    return { text: "!", tone: "critical", label: L("Kubernetes cluster unreachable", "Нет связи с кластером Kubernetes") };
  }
  if (!snapshot) return null;
  const bad = snapshot.pods.filter((p) => toneForPod(p) === "bad").length;
  const badWl = snapshot.workloads.filter((w) => !w.healthy).length;
  const notReadyNodes = snapshot.nodes.filter((n) => !n.ready).length;
  const total = bad + notReadyNodes;
  if (total > 0) {
    return { count: total, tone: "critical", label: L(`${bad} failing pods, ${notReadyNodes} nodes not ready`, `упавших подов: ${bad}, неготовых нод: ${notReadyNodes}`) };
  }
  if (badWl > 0) return { count: badWl, tone: "warning", label: L(`${badWl} degraded workloads`, `деградировавших деплойментов: ${badWl}`) };
  return null;
}
