// Pods and Deployments (plus StatefulSets / DaemonSets).
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Metrics, Pod, Snapshot, Workload } from "../../contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { actions } from "../dialogs";
import {
  ActionButton,
  ago,
  dotClass,
  FilterBar,
  fmtBytes,
  fmtCpu,
  IconButton,
  isRecent,
  NameCell,
  SectionCard,
  StatusPill,
  td,
  textClass,
  th,
  Toggle,
  toneForPod,
  useGo,
  useNow,
  type Tone,
} from "../shared";
import { filters, useMatchers, useResource } from "../store";
import { L } from "../i18n";

export interface SectionProps {
  snapshot: Snapshot;
  readOnly: boolean;
}

// ---- sorting ------------------------------------------------------------------

type Dir = "asc" | "desc";
function useSort<K extends string>(initial: K, dir: Dir = "asc") {
  const [sort, setSort] = useState<{ key: K; dir: Dir }>({ key: initial, dir });
  const header = (key: K, label: string, className?: string, defaultDir: Dir = "desc") => (
    <th className={cn(th, className)} aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      <button
        type="button"
        className={cn("inline-flex items-center gap-1 hover:text-foreground", sort.key === key && "text-foreground")}
        onClick={() =>
          setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDir }))
        }
      >
        {label}
        {sort.key === key ? <span aria-hidden="true">{sort.dir === "asc" ? "↑" : "↓"}</span> : null}
      </button>
    </th>
  );
  return { sort, header };
}

function cmp(a: number | string, b: number | string, dir: Dir) {
  const r = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  return dir === "asc" ? r : -r;
}

const TONE_RANK: Record<Tone, number> = { bad: 0, warn: 1, info: 2, good: 3, muted: 4 };

// ---- pods ------------------------------------------------------------------------

function usageIndex(metrics: Metrics | null) {
  const map = new Map<string, { cpu: number; mem: number }>();
  for (const p of metrics?.pods ?? []) map.set(`${p.namespace}/${p.name}`, p);
  return map;
}

const WORKLOAD_SECTION = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

export function PodTable({
  pods,
  readOnly,
  showNs = true,
  metrics,
}: {
  pods: Pod[];
  readOnly: boolean;
  showNs?: boolean;
  metrics?: Metrics | null;
}) {
  const now = useNow(10_000);
  const go = useGo();
  const usage = useMemo(() => usageIndex(metrics ?? null), [metrics]);
  const hasUsage = (metrics?.pods.length ?? 0) > 0;
  type Key = "status" | "name" | "restarts" | "age" | "cpu" | "mem";
  const { sort, header } = useSort<Key>("status", "asc");
  const sorted = useMemo(() => {
    const u = (p: Pod) => usage.get(`${p.namespace}/${p.name}`);
    return [...pods].sort((a, b) => {
      switch (sort.key) {
        case "name":
          return cmp(`${a.namespace}/${a.name}`, `${b.namespace}/${b.name}`, sort.dir);
        case "restarts":
          return cmp(a.restarts, b.restarts, sort.dir);
        case "age":
          return cmp(Date.parse(b.createdAt), Date.parse(a.createdAt), sort.dir);
        case "cpu":
          return cmp(u(a)?.cpu ?? -1, u(b)?.cpu ?? -1, sort.dir);
        case "mem":
          return cmp(u(a)?.mem ?? -1, u(b)?.mem ?? -1, sort.dir);
        default:
          return (
            cmp(TONE_RANK[toneForPod(a)], TONE_RANK[toneForPod(b)], sort.dir) ||
            a.namespace.localeCompare(b.namespace) ||
            a.name.localeCompare(b.name)
          );
      }
    });
  }, [pods, sort, usage]);

  const openWorkload = (p: Pod) => {
    if (!p.workload) return;
    filters.update({ workload: { namespace: p.namespace, kind: p.workload.kind, name: p.workload.name } });
    go(WORKLOAD_SECTION.has(p.workload.kind) ? "deployments" : p.workload.kind === "Job" ? "jobs" : "pods");
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-border">
          <tr>
            {header("name", L("Pod", "Под"), undefined, "asc")}
            {header("status", L("Status", "Статус"), undefined, "asc")}
            <th className={th}>{L("Ready", "Готов")}</th>
            {header("restarts", L("Restarts", "Перезапуски"), "text-right")}
            {hasUsage ? header("cpu", "CPU", "text-right") : null}
            {hasUsage ? header("mem", L("Memory", "Память"), "text-right") : null}
            {header("age", L("Age", "Возраст"), "text-right", "asc")}
            <th className={cn(th, "hidden min-[1800px]:table-cell")}>{L("Node", "Нода")}</th>
            <th className={cn(th, "text-right")}>{L("Actions", "Действия")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((p) => {
            const u = usage.get(`${p.namespace}/${p.name}`);
            return (
              <tr key={`${p.namespace}/${p.name}`} className="hover:bg-state-hover/50">
                <NameCell
                  name={p.name}
                  className="max-w-[260px]"
                  title={`${p.namespace}/${p.name}${p.node ? `\nnode ${p.node}` : ""}${p.ip ? `\nIP ${p.ip}` : ""}`}
                  sub={
                    <>
                      {showNs ? p.namespace : null}
                      {p.workload ? (
                        <>
                          {showNs ? " · " : null}
                          {p.workload.kind} {p.workload.name}
                        </>
                      ) : null}
                    </>
                  }
                />
                <td className={td}>
                  <StatusPill tone={toneForPod(p)}>{p.status}</StatusPill>
                </td>
                <td className={cn(td, "font-mono text-xs tabular-nums")}>{p.ready}</td>
                <td className={cn(td, "text-right text-xs tabular-nums")}>
                  <span
                    className={cn(p.restarts > 0 && isRecent(p.lastRestartAt) && textClass.warn)}
                    title={p.lastRestartAt ? L(`last restart ${ago(p.lastRestartAt, now)} ago`, `последний перезапуск ${ago(p.lastRestartAt, now)} назад`) : undefined}
                  >
                    {p.restarts}
                    {p.restarts > 0 && p.lastRestartAt ? (
                      <span className="ml-1 text-muted-foreground">({ago(p.lastRestartAt, now)})</span>
                    ) : null}
                  </span>
                </td>
                {hasUsage ? (
                  <td className={cn(td, "text-right font-mono text-xs tabular-nums")} title={p.cpuRequest ? L(`request ${fmtCpu(p.cpuRequest)}${p.cpuLimit ? `, limit ${fmtCpu(p.cpuLimit)}` : ""}`, `запрос ${fmtCpu(p.cpuRequest)}${p.cpuLimit ? `, лимит ${fmtCpu(p.cpuLimit)}` : ""}`) : undefined}>
                    {u ? fmtCpu(u.cpu) : "—"}
                  </td>
                ) : null}
                {hasUsage ? (
                  <td
                    className={cn(td, "text-right font-mono text-xs tabular-nums", u && p.memLimit && u.mem / p.memLimit > 0.9 && textClass.bad)}
                    title={p.memRequest ? L(`request ${fmtBytes(p.memRequest)}${p.memLimit ? `, limit ${fmtBytes(p.memLimit)}` : ""}`, `запрос ${fmtBytes(p.memRequest)}${p.memLimit ? `, лимит ${fmtBytes(p.memLimit)}` : ""}`) : undefined}
                  >
                    {u ? fmtBytes(u.mem) : "—"}
                  </td>
                ) : null}
                <td className={cn(td, "text-right text-xs tabular-nums text-muted-foreground")}>{ago(p.createdAt, now)}</td>
                <td className={cn(td, "hidden max-w-[180px] truncate text-xs text-muted-foreground min-[1800px]:table-cell")} title={p.node ?? ""}>
                  {p.node ?? "—"}
                </td>
                <td className={cn(td, "whitespace-nowrap text-right")}>
                  <div className="inline-flex items-center gap-1">
                    <ActionButton icon="ScrollText" label={L("Logs", "Логи")} hint={L("Show this pod's logs (all containers, newest at the bottom)", "Логи пода (все контейнеры, новые строки внизу)")} onClick={() => actions.podLogs(p)} />
                    {readOnly ? null : (
                      <ActionButton icon="RotateCcw" label={L("Restart", "Перезапуск")} hint={L("Restart: delete the pod so its controller starts a fresh one (asks first)", "Перезапуск: удалить под, контроллер поднимет новый (сначала спросит)")} danger onClick={() => actions.restartPod(p)} />
                    )}
                    {p.workload && WORKLOAD_SECTION.has(p.workload.kind) ? (
                      <ActionButton icon="Layers" label={p.workload.kind} hint={L(`Open the ${p.workload.kind} that owns this pod: ${p.workload.name}`, `Открыть ${p.workload.kind}, которому принадлежит под: ${p.workload.name}`)} hideLabelBelow="wide" onClick={() => openWorkload(p)} />
                    ) : null}
                    <IconButton icon="ArrowRightLeft" label={L("Port-forward", "Проброс порта")} hint={L("Port-forward: open a port of this object on localhost", "Проброс порта: открыть порт этого объекта на localhost")} onClick={() => actions.podPortForward(p)} />
                    <IconButton icon="FileText" label={L("Describe", "Описание")} hint={L("Describe: full kubectl describe output (spec, status, events)", "Описание: полный вывод kubectl describe (spec, status, события)")} onClick={() => actions.describe("pod", p.namespace, p.name)} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function filterPods(
  pods: Pod[],
  m: ReturnType<typeof useMatchers>,
  opts: { problemsOnly?: boolean } = {},
) {
  const { filters: f } = m;
  return pods.filter(
    (p) =>
      m.ns(p.namespace) &&
      m.text(`${p.namespace}/${p.name} ${p.status} ${p.node ?? ""} ${p.workload?.name ?? ""}`) &&
      (!f.workload ||
        (p.namespace === f.workload.namespace &&
          p.workload?.name === f.workload.name &&
          p.workload.kind === f.workload.kind)) &&
      (!f.node || p.node === f.node) &&
      (!opts.problemsOnly || !p.healthy),
  );
}

export function PodsSection({ snapshot, readOnly }: SectionProps) {
  const m = useMatchers();
  const metrics = useResource("metrics");
  const filtered = useMemo(
    () => filterPods(snapshot.pods, m, { problemsOnly: m.filters.problemsOnly }),
    [snapshot.pods, m.ns, m.text, m.filters],
  );
  return (
    <>
      <FilterBar count={filtered.length} total={snapshot.pods.length}>
        <Toggle value={m.filters.problemsOnly} onChange={(v) => filters.update({ problemsOnly: v })}>
          <Icon name="kube-AlertTriangle" className="size-3.5" />
          {L("Problems only", "Только проблемные")}
        </Toggle>
      </FilterBar>
      <SectionCard title={L("Pods", "Поды")}>
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{L("No pods match.", "Подходящих подов нет.")}</p>
        ) : (
          <PodTable
            pods={filtered}
            readOnly={readOnly}
            showNs={snapshot.selection.namespace === "*"}
            metrics={metrics.data}
          />
        )}
      </SectionCard>
    </>
  );
}

// ---- deployments / workloads -------------------------------------------------------

function workloadTone(w: Workload): Tone {
  if (!w.healthy) return w.ready === 0 && w.desired > 0 ? "bad" : "warn";
  return w.desired === 0 ? "muted" : "good";
}

export function WorkloadTable({
  workloads,
  pods,
  readOnly,
  metrics,
}: {
  workloads: Workload[];
  pods: Pod[];
  readOnly: boolean;
  metrics?: Metrics | null;
}) {
  const now = useNow(10_000);
  const go = useGo();
  const podsOf = useMemo(() => {
    const map = new Map<string, Pod[]>();
    for (const p of pods) {
      if (!p.workload) continue;
      const key = `${p.workload.kind}/${p.namespace}/${p.workload.name}`;
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    return map;
  }, [pods]);
  const usage = useMemo(() => usageIndex(metrics ?? null), [metrics]);
  const hasUsage = (metrics?.pods.length ?? 0) > 0;
  type Key = "status" | "name" | "restarts" | "age" | "cpu" | "mem";
  const { sort, header } = useSort<Key>("status", "asc");
  const rows = useMemo(() => {
    const enriched = workloads.map((w) => {
      const ps = podsOf.get(`${w.kind}/${w.namespace}/${w.name}`) ?? [];
      let cpu = 0;
      let mem = 0;
      for (const p of ps) {
        const u = usage.get(`${p.namespace}/${p.name}`);
        cpu += u?.cpu ?? 0;
        mem += u?.mem ?? 0;
      }
      return { w, pods: ps, restarts: ps.reduce((a, p) => a + p.restarts, 0), cpu, mem };
    });
    return enriched.sort((a, b) => {
      switch (sort.key) {
        case "name":
          return cmp(`${a.w.namespace}/${a.w.name}`, `${b.w.namespace}/${b.w.name}`, sort.dir);
        case "restarts":
          return cmp(a.restarts, b.restarts, sort.dir);
        case "age":
          return cmp(Date.parse(b.w.createdAt), Date.parse(a.w.createdAt), sort.dir);
        case "cpu":
          return cmp(a.cpu, b.cpu, sort.dir);
        case "mem":
          return cmp(a.mem, b.mem, sort.dir);
        default:
          return (
            cmp(TONE_RANK[workloadTone(a.w)], TONE_RANK[workloadTone(b.w)], sort.dir) ||
            a.w.namespace.localeCompare(b.w.namespace) ||
            a.w.name.localeCompare(b.w.name)
          );
      }
    });
  }, [workloads, podsOf, usage, sort]);

  const showPods = (w: Workload) => {
    filters.update({ workload: { namespace: w.namespace, kind: w.kind, name: w.name } });
    go("pods");
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-border">
          <tr>
            {header("name", L("Name", "Имя"), undefined, "asc")}
            <th className={th}>{L("Kind", "Тип")}</th>
            {header("status", L("Ready", "Готовность"), undefined, "asc")}
            {header("restarts", L("Restarts", "Перезапуски"), "text-right")}
            {hasUsage ? header("cpu", "CPU", "text-right") : null}
            {hasUsage ? header("mem", L("Memory", "Память"), "text-right") : null}
            {header("age", L("Age", "Возраст"), "text-right", "asc")}
            <th className={cn(th, "text-right")}>{L("Actions", "Действия")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(({ w, pods: ps, restarts, cpu, mem }) => {
            const tone = workloadTone(w);
            const fill = w.desired === 0 ? 0 : Math.min(100, (w.ready / w.desired) * 100);
            return (
              <tr key={`${w.kind}/${w.namespace}/${w.name}`} className="hover:bg-state-hover/50">
                <NameCell
                  name={w.name}
                  className="max-w-[300px]"
                  sub={
                    <span title={[w.message, ...w.images].filter(Boolean).join("\n")}>
                      {w.namespace}
                      {w.message ? ` · ${w.message}` : w.progressing ? L(" · rolling out", " · выкатывается") : ""}
                      {!w.message ? ` · ${w.images[0]?.split("/").at(-1) ?? ""}` : ""}
                    </span>
                  }
                />
                <td className={cn(td, "text-xs text-muted-foreground")}>{w.kind}</td>
                <td className={td}>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
                      <div className={cn("h-full", dotClass[tone])} style={{ width: `${fill}%` }} />
                    </div>
                    <span className="font-mono text-xs tabular-nums">
                      {w.ready}/{w.desired}
                    </span>
                  </div>
                </td>
                <td className={cn(td, "text-right text-xs tabular-nums", restarts > 0 && "text-amber-600 dark:text-amber-400")}>{restarts}</td>
                {hasUsage ? <td className={cn(td, "text-right font-mono text-xs tabular-nums")}>{ps.length ? fmtCpu(cpu) : "—"}</td> : null}
                {hasUsage ? <td className={cn(td, "text-right font-mono text-xs tabular-nums")}>{ps.length ? fmtBytes(mem) : "—"}</td> : null}
                <td className={cn(td, "text-right text-xs tabular-nums text-muted-foreground")}>{ago(w.createdAt, now)}</td>
                <td className={cn(td, "whitespace-nowrap text-right")}>
                  <div className="inline-flex items-center gap-1">
                    <ActionButton icon="Box" label={L(`Pods ${ps.length}`, `Поды ${ps.length}`)} hint={L(`Show the ${ps.length} pods of this ${w.kind}`, `Показать поды этого ${w.kind} (${ps.length})`)} onClick={() => showPods(w)} />
                    <ActionButton icon="ScrollText" label={L("Logs", "Логи")} hint={L("Logs from all its pods, merged by time", "Логи всех его подов, по времени")} disabled={!w.selector || ps.length === 0} onClick={() => actions.workloadLogs(w)} />
                    {readOnly ? null : (
                      <>
                        <ActionButton icon="RotateCcw" label={L("Restart", "Перезапуск")} hint={L("Rollout restart: replace pods one by one, no downtime with 2+ replicas (asks first)", "Rollout restart: поды заменяются по одному, без простоя при 2+ репликах (сначала спросит)")} danger onClick={() => actions.rolloutRestart(w)} />
                        {w.kind !== "DaemonSet" ? (
                          <span className="inline-flex items-center">
                            <IconButton icon="Minus" label={L("Scale down", "Уменьшить")} hint={L("Scale down: remove one replica (asks first)", "Убрать одну реплику (сначала спросит)")} disabled={w.desired === 0} onClick={() => actions.scale(w, w.desired - 1)} />
                            <IconButton icon="Plus" label={L("Scale up", "Увеличить")} hint={L("Scale up: add one replica (asks first)", "Добавить одну реплику (сначала спросит)")} onClick={() => actions.scale(w, w.desired + 1)} />
                          </span>
                        ) : null}
                      </>
                    )}
                    <IconButton icon="ArrowRightLeft" label={L("Port-forward", "Проброс порта")} hint={L("Port-forward: open a port of this object on localhost", "Проброс порта: открыть порт этого объекта на localhost")} disabled={ps.length === 0} onClick={() => actions.workloadPortForward(w, ps)} />
                    <IconButton icon="FileText" label={L("Describe", "Описание")} hint={L("Describe: full kubectl describe output (spec, status, events)", "Описание: полный вывод kubectl describe (spec, status, события)")} onClick={() => actions.describe(w.kind, w.namespace, w.name)} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DeploymentsSection({ snapshot, readOnly }: SectionProps) {
  const m = useMatchers();
  const metrics = useResource("metrics");
  const [kind, setKind] = useState<"all" | Workload["kind"]>("Deployment");
  const f = m.filters;
  const filtered = useMemo(
    () =>
      snapshot.workloads.filter(
        (w) =>
          (kind === "all" || w.kind === kind || (f.workload !== null && f.workload.kind === w.kind)) &&
          m.ns(w.namespace) &&
          m.text(`${w.namespace}/${w.name} ${w.images.join(" ")}`) &&
          (!f.workload || (f.workload.namespace === w.namespace && f.workload.name === w.name && f.workload.kind === w.kind)) &&
          (!f.problemsOnly || !w.healthy),
      ),
    [snapshot.workloads, kind, m, f.workload, f.problemsOnly],
  );
  const countOf = (k: Workload["kind"]) => snapshot.workloads.filter((w) => w.kind === k && m.ns(w.namespace)).length;
  const kinds: { value: "all" | Workload["kind"]; label: ReactNode }[] = [
    { value: "Deployment", label: `Deployments ${countOf("Deployment")}` },
    { value: "StatefulSet", label: `StatefulSets ${countOf("StatefulSet")}` },
    { value: "DaemonSet", label: `DaemonSets ${countOf("DaemonSet")}` },
    { value: "all", label: L("All", "Все") },
  ];
  return (
    <>
      <FilterBar count={filtered.length}>
        {kinds.map((k) => (
          <Toggle key={k.value} value={kind === k.value} onChange={() => setKind(k.value)}>
            {k.label}
          </Toggle>
        ))}
        <Toggle value={f.problemsOnly} onChange={(v) => filters.update({ problemsOnly: v })}>
          <Icon name="kube-AlertTriangle" className="size-3.5" />
          {L("Problems only", "Только проблемные")}
        </Toggle>
      </FilterBar>
      <SectionCard title={kind === "all" ? L("Workloads", "Все ворклоады") : kind === "Deployment" ? L("Deployments", "Деплойменты") : `${kind}s`}>
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{L("Nothing matches.", "Ничего не найдено.")}</p>
        ) : (
          <WorkloadTable workloads={filtered} pods={snapshot.pods} readOnly={readOnly} metrics={metrics.data} />
        )}
      </SectionCard>
    </>
  );
}
