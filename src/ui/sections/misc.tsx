// Jobs, Services & Ingress, Port-forwards, Events.
import { useMemo, useState } from "react";
import type { Job, KubeEvent, PortForward } from "../../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { actions } from "../dialogs";
import {
  ActionButton,
  ago,
  Dot,
  FilterBar,
  IconButton,
  NameCell,
  NativeSelect,
  SectionCard,
  StatusPill,
  td,
  th,
  Toggle,
  useNow,
} from "../shared";
import { useMatchers, usePortForwards } from "../store";
import type { SectionProps } from "./workloads";
import { L } from "../i18n";

// ---- jobs ----------------------------------------------------------------------

export function JobsSection({ snapshot, readOnly }: SectionProps) {
  const now = useNow(10_000);
  const m = useMatchers();
  const f = m.filters;
  const filtered = snapshot.jobs.filter(
    (j) =>
      m.ns(j.namespace) &&
      m.text(`${j.kind} ${j.namespace}/${j.name} ${j.status}`) &&
      (!f.workload || (f.workload.kind === "Job" && f.workload.name === j.name && f.workload.namespace === j.namespace)) &&
      (!f.problemsOnly || !j.healthy),
  );
  const cron = filtered.filter((j) => j.kind === "CronJob");
  const jobs = filtered.filter((j) => j.kind === "Job").sort((a, b) => (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? ""));
  const row = (j: Job) => (
    <tr key={`${j.kind}/${j.namespace}/${j.name}`} className="hover:bg-state-hover/50">
      <NameCell name={j.name} sub={j.namespace} />
      <td className={td}>
        <StatusPill tone={!j.healthy ? "bad" : j.status === "Running" ? "info" : j.suspended ? "muted" : "good"}>{j.status}</StatusPill>
      </td>
      <td className={cn(td, "font-mono text-xs text-muted-foreground")}>{j.schedule ?? ""}</td>
      <td className={cn(td, "text-right text-xs tabular-nums text-muted-foreground")}>{ago(j.lastRunAt, now)}</td>
      <td className={cn(td, "whitespace-nowrap text-right")}>
        <div className="inline-flex items-center gap-1">
          {j.kind === "CronJob" && !readOnly ? <ActionButton icon="Play" label={L("Run now", "Запустить")} hint={L("Run now: create a one-off Job from this CronJob (asks first)", "Запустить сейчас: создать разовый Job из этого CronJob (сначала спросит)")} danger onClick={() => actions.trigger(j)} /> : null}
          <IconButton icon="FileText" label={L("Describe", "Описание")} hint={L("Describe: full kubectl describe output (spec, status, events)", "Описание: полный вывод kubectl describe (spec, status, события)")} onClick={() => actions.describe(j.kind, j.namespace, j.name)} />
        </div>
      </td>
    </tr>
  );
  const table = (rows: Job[]) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-border">
          <tr>
            <th className={th}>{L("Name", "Имя")}</th>
            <th className={th}>{L("Status", "Статус")}</th>
            <th className={th}>{L("Schedule", "Расписание")}</th>
            <th className={cn(th, "text-right")}>{L("Last run", "Последний запуск")}</th>
            <th className={cn(th, "text-right")}>{L("Actions", "Действия")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{rows.map(row)}</tbody>
      </table>
    </div>
  );
  return (
    <>
      <FilterBar count={filtered.length} />
      <SectionCard title={`CronJobs (${cron.length})`}>
        {cron.length ? table(cron) : <p className="px-3 py-4 text-sm text-muted-foreground">{L("No CronJobs.", "CronJob нет.")}</p>}
      </SectionCard>
      <SectionCard title={`Jobs (${jobs.length})`}>
        {jobs.length ? table(jobs.slice(0, 300)) : <p className="px-3 py-4 text-sm text-muted-foreground">{L("No Jobs.", "Job нет.")}</p>}
      </SectionCard>
    </>
  );
}

// ---- services & ingress ------------------------------------------------------------

export function NetworkSection({ snapshot }: SectionProps) {
  const m = useMatchers();
  const services = snapshot.services.filter((s) => m.ns(s.namespace) && m.text(`${s.namespace}/${s.name} ${s.type}`));
  const ingresses = snapshot.ingresses.filter((i) => m.ns(i.namespace) && m.text(`${i.namespace}/${i.name} ${i.hosts.join(" ")}`));
  return (
    <>
      <FilterBar count={services.length + ingresses.length} />
      <SectionCard title={`Ingresses (${ingresses.length})`}>
        {ingresses.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{L("No ingresses.", "Ingress нет.")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {ingresses.map((i) => (
              <li key={`${i.namespace}/${i.name}`} className="flex items-center gap-3 px-3 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono">{i.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {i.namespace}
                    {i.className ? ` · ${i.className}` : ""}
                    {i.address ? ` · ${i.address}` : ""}
                  </div>
                </div>
                <div className="flex max-w-[55%] flex-wrap justify-end gap-1">
                  {i.hosts.map((h) => (
                    <a key={h} href={`https://${h}`} target="_blank" rel="noreferrer" className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] hover:bg-state-hover">
                      {h}
                    </a>
                  ))}
                </div>
                <IconButton icon="FileText" label={L("Describe", "Описание")} hint={L("Describe: full kubectl describe output (spec, status, events)", "Описание: полный вывод kubectl describe (spec, status, события)")} onClick={() => actions.describe("ingress", i.namespace, i.name)} />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title={L(`Services (${services.length})`, `Сервисы (${services.length})`)}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border">
              <tr>
                <th className={th}>{L("Name", "Имя")}</th>
                <th className={th}>{L("Type", "Тип")}</th>
                <th className={th}>Cluster IP</th>
                <th className={th}>{L("External", "Внешний")}</th>
                <th className={th}>{L("Ports", "Порты")}</th>
                <th className={cn(th, "text-right")}>{L("Actions", "Действия")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {services.map((s) => {
                const ports = s.ports.map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol}`).join(", ");
                return (
                  <tr key={`${s.namespace}/${s.name}`} className="hover:bg-state-hover/50">
                    <NameCell name={s.name} sub={s.namespace} className="max-w-[280px]" />
                    <td className={cn(td, "text-xs")}>{s.type}</td>
                    <td className={cn(td, "font-mono text-xs text-muted-foreground")}>{s.clusterIP ?? "—"}</td>
                    <td className={cn(td, "font-mono text-xs")}>{s.externalIP ?? "—"}</td>
                    <td className={cn(td, "max-w-[220px] truncate font-mono text-[11px] text-muted-foreground")} title={ports}>
                      {ports}
                    </td>
                    <td className={cn(td, "whitespace-nowrap text-right")}>
                      <div className="inline-flex items-center gap-1">
                        <ActionButton
                          icon="ArrowRightLeft"
                          label={L("Port-forward", "Проброс порта")}
                          hint={L("Port-forward: open a port of this service on localhost", "Проброс порта: открыть порт этого сервиса на localhost")}
                          disabled={s.ports.length === 0 || s.clusterIP === "None"}
                          onClick={() => actions.servicePortForward(s)}
                        />
                        <IconButton icon="FileText" label={L("Describe", "Описание")} hint={L("Describe: full kubectl describe output (spec, status, events)", "Описание: полный вывод kubectl describe (spec, status, события)")} onClick={() => actions.describe("service", s.namespace, s.name)} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </>
  );
}

// ---- port-forwards -------------------------------------------------------------------

export function PortForwardsSection({ snapshot }: SectionProps) {
  const list = usePortForwards();
  const now = useNow(5_000);
  const m = useMatchers();
  const [kind, setKind] = useState<"service" | "pod" | "deployment">("service");
  const [target, setTarget] = useState("");

  const candidates = useMemo(() => {
    if (kind === "service") {
      return snapshot.services
        .filter((s) => m.ns(s.namespace) && s.ports.length > 0 && s.clusterIP !== "None")
        .map((s) => ({ key: `${s.namespace}/${s.name}`, open: () => actions.servicePortForward(s) }));
    }
    if (kind === "pod") {
      return snapshot.pods
        .filter((p) => m.ns(p.namespace) && p.phase === "Running")
        .map((p) => ({ key: `${p.namespace}/${p.name}`, open: () => actions.podPortForward(p) }));
    }
    return snapshot.workloads
      .filter((w) => m.ns(w.namespace) && w.kind !== "DaemonSet")
      .map((w) => ({
        key: `${w.namespace}/${w.name}`,
        open: () =>
          actions.workloadPortForward(
            w,
            snapshot.pods.filter((p) => p.namespace === w.namespace && p.workload?.name === w.name),
          ),
      }));
  }, [kind, snapshot, m]);
  const chosen = candidates.find((c) => c.key === target) ?? candidates[0];

  const rowTone = (p: PortForward) => (p.status === "running" ? "good" : p.status === "starting" ? "info" : p.status === "error" ? "bad" : "muted");

  return (
    <>
      <SectionCard title={L("New port-forward", "Новый проброс порта")}>
        <div className="flex flex-wrap items-center gap-2 p-3">
          <NativeSelect
            className="w-36"
            label={L("Kind", "Тип")}
            value={kind}
            onChange={(v) => {
              setKind(v as typeof kind);
              setTarget("");
            }}
            options={[
              { value: "service", label: L("Service", "Сервис") },
              { value: "deployment", label: L("Deployment", "Деплоймент") },
              { value: "pod", label: L("Pod", "Под") },
            ]}
          />
          <NativeSelect
            className="min-w-[260px] flex-1"
            label={L("Target", "Объект")}
            value={chosen?.key ?? ""}
            onChange={setTarget}
            options={candidates.length ? candidates.map((c) => ({ value: c.key, label: c.key })) : [{ value: "", label: L("Nothing in the selected namespaces", "В выбранных неймспейсах ничего нет") }]}
          />
          <Button size="sm" disabled={!chosen} onClick={() => chosen?.open()}>
            <Icon name="kube-ArrowRightLeft" className="size-3.5" />
            {L("Choose port…", "Выбрать порт…")}
          </Button>
        </div>
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {L("Forwards bind", "Порты открываются на")} <span className="font-mono">127.0.0.1</span> {L("on the machine running bb and stop when the plugin reloads. Every row in Pods, Deployments and Services also has a port-forward button.", "машины, где работает bb, и закрываются при перезапуске плагина. Кнопка проброса есть и в каждой строке подов, деплойментов и сервисов.")}
        </p>
      </SectionCard>
      <SectionCard title={L(`Port-forwards (${list.length})`, `Пробросы портов (${list.length})`)}>
        {list.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{L("Nothing is forwarded.", "Ничего не проброшено.")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {list.map((p) => {
              const url = p.localPort ? `http://localhost:${p.localPort}` : null;
              const live = p.status === "running" || p.status === "starting";
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-xs">
                  <StatusPill tone={rowTone(p)}>{p.status}</StatusPill>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono">
                      127.0.0.1:{p.localPort ?? "…"} → {p.kind}/{p.name}:{p.remotePort}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground" title={p.error ?? undefined}>
                      {p.context} · {p.namespace} · started {ago(p.startedAt, now)} ago · {p.connections} connections
                      {p.error ? ` · ${p.error}` : ""}
                    </div>
                  </div>
                  <div className="inline-flex items-center gap-1">
                    {url && live ? (
                      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" asChild>
                        <a href={url} target="_blank" rel="noreferrer">
                          <Icon name="kube-ExternalLink" className="size-3.5" />
                          {L("Open", "Открыть")}
                        </a>
                      </Button>
                    ) : null}
                    {url ? <IconButton icon="Copy" label={L("Copy address", "Копировать адрес")} hint={L("Copy localhost:port to the clipboard", "Скопировать localhost:порт в буфер обмена")} onClick={() => void navigator.clipboard.writeText(`localhost:${p.localPort}`)} /> : null}
                    <ActionButton icon={live ? "Square" : "X"} label={live ? L("Stop", "Остановить") : L("Remove", "Убрать")} hint={live ? L("Stop this port-forward", "Остановить проброс порта") : L("Remove it from the list", "Убрать из списка")} danger={live} onClick={() => void actions.stopPortForward(p.id)} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </>
  );
}

// ---- events -----------------------------------------------------------------------

export function EventList({ events, compact }: { events: KubeEvent[]; compact?: boolean }) {
  const now = useNow(10_000);
  if (events.length === 0) return <p className="px-3 py-4 text-sm text-muted-foreground">{L("No events.", "Событий нет.")}</p>;
  return (
    <ul className="divide-y divide-border">
      {events.map((e, i) => (
        <li key={`${e.namespace}/${e.object}/${e.reason}/${i}`} className="flex gap-2 px-3 py-2 text-xs">
          <span className="pt-1">
            <Dot tone={e.type === "Warning" ? "warn" : "muted"} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{e.reason}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                {e.namespace}/{e.object}
              </span>
              {e.count > 1 ? <span className="text-muted-foreground">×{e.count}</span> : null}
              <span className="tabular-nums text-muted-foreground">{ago(e.lastSeen, now)}</span>
            </div>
            <div className={cn("text-muted-foreground", compact ? "line-clamp-2" : "whitespace-pre-wrap break-words")}>{e.message}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function EventsSection({ snapshot }: SectionProps) {
  const [warningsOnly, setWarningsOnly] = useState(true);
  const m = useMatchers();
  const filtered = snapshot.events.filter(
    (e) => (!warningsOnly || e.type === "Warning") && m.ns(e.namespace) && m.text(`${e.namespace} ${e.object} ${e.reason} ${e.message}`),
  );
  return (
    <>
      <FilterBar count={filtered.length}>
        <Toggle value={warningsOnly} onChange={setWarningsOnly}>
          <Icon name="kube-AlertTriangle" className="size-3.5" />
          {L("Warnings only", "Только предупреждения")}
        </Toggle>
      </FilterBar>
      <SectionCard title={L("Events", "События")}>
        <EventList events={filtered} />
      </SectionCard>
    </>
  );
}
