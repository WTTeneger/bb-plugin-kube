// ArgoCD applications read from the Application CRD with kubectl: no argocd
// CLI or API token needed.
import { useMemo, useState } from "react";
import type { ArgoApp } from "../../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { actions } from "../dialogs";
import {
  ActionButton,
  ago,
  Chip,
  EmptyState,
  ErrorBox,
  FilterBar,
  Hint,
  IconButton,
  Metric,
  SectionCard,
  StatusPill,
  Toggle,
  useGo,
  useNow,
  type Tone,
} from "../shared";
import { filters, useMatchers, useResource } from "../store";
import type { SectionProps } from "./workloads";
import { L } from "../i18n";

export function syncTone(s: string): Tone {
  return s === "Synced" ? "good" : s === "OutOfSync" ? "warn" : "muted";
}
export function healthTone(h: string): Tone {
  switch (h) {
    case "Healthy":
      return "good";
    case "Progressing":
      return "info";
    case "Degraded":
    case "Missing":
      return "bad";
    case "Suspended":
      return "muted";
    default:
      return "warn";
  }
}
export function appHasProblem(a: ArgoApp) {
  return a.sync !== "Synced" || (a.health !== "Healthy" && a.health !== "Progressing") || a.operationPhase === "Failed" || a.operationPhase === "Error";
}

const short = (rev: string | null) => (rev && /^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 7) : rev);

function repoLabel(repo: string | null) {
  if (!repo) return null;
  return repo.replace(/^https?:\/\//, "").replace(/^git@/, "").replace(/\.git$/, "");
}

export function ArgoSection({ snapshot, readOnly }: SectionProps) {
  const argo = useResource("argocd");
  const m = useMatchers();
  const now = useNow(10_000);
  const go = useGo();
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  // A public ArgoCD UI, if an ingress in the ArgoCD namespace exposes one.
  const uiBase = useMemo(() => {
    const appNs = argo.data?.apps[0]?.namespace ?? "argocd";
    const ing = snapshot.ingresses.find((i) => i.namespace === appNs && i.hosts.length > 0);
    return ing ? `https://${ing.hosts[0]}` : null;
  }, [snapshot.ingresses, argo.data]);

  if (!argo.data) {
    return argo.error ? (
      <ErrorBox title={L("Can't read ArgoCD applications", "Не удалось прочитать приложения ArgoCD")} error={argo.error} onRetry={argo.reload} />
    ) : (
      <EmptyState>{L("Loading ArgoCD applications…", "Загрузка приложений ArgoCD…")}</EmptyState>
    );
  }
  if (!argo.data.installed) {
    return <EmptyState>{L("ArgoCD is not installed in this cluster (no applications.argoproj.io resource).", "ArgoCD в этом кластере не установлен (нет ресурса applications.argoproj.io).")}</EmptyState>;
  }
  if (argo.data.error) return <ErrorBox title={L("Can't read ArgoCD applications", "Не удалось прочитать приложения ArgoCD")} error={argo.data.error} onRetry={argo.reload} />;

  const apps = argo.data.apps.filter((a) => m.ns(a.destNamespace) || m.ns(a.namespace));
  const rows = apps
    .filter(
      (a) =>
        m.text(`${a.name} ${a.project} ${a.destNamespace ?? ""} ${a.repo ?? ""} ${a.path ?? ""} ${a.chart ?? ""}`) &&
        (!problemsOnly || appHasProblem(a)),
    )
    .sort(
      (a, b) => Number(appHasProblem(b)) - Number(appHasProblem(a)) || a.name.localeCompare(b.name),
    );
  const count = (f: (a: ArgoApp) => boolean) => apps.filter(f).length;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label={L("Applications", "Приложения")} value={apps.length} note={L(`${count((a) => a.autoSync)} with auto-sync`, `с авто-синхронизацией: ${count((a) => a.autoSync)}`)} />
        <Metric
          label={L("Out of sync", "Не синхронизированы")}
          value={count((a) => a.sync !== "Synced")}
          tone={count((a) => a.sync !== "Synced") ? "warn" : "good"}
          note={L(`${count((a) => a.sync === "Synced")} synced`, `синхронизировано: ${count((a) => a.sync === "Synced")}`)}
          onClick={() => setProblemsOnly(true)}
        />
        <Metric
          label={L("Unhealthy", "Нездоровые")}
          value={count((a) => a.health === "Degraded" || a.health === "Missing")}
          tone={count((a) => a.health === "Degraded" || a.health === "Missing") ? "bad" : "good"}
          note={L(`${count((a) => a.health === "Progressing")} progressing · ${count((a) => a.health === "Healthy")} healthy`, `выкатываются: ${count((a) => a.health === "Progressing")} · здоровы: ${count((a) => a.health === "Healthy")}`)}
          onClick={() => setProblemsOnly(true)}
        />
        <Metric
          label={L("Operations", "Операции")}
          value={count((a) => a.operationPhase === "Running")}
          note={L(`${count((a) => a.operationPhase === "Failed" || a.operationPhase === "Error")} last syncs failed`, `последняя синхронизация упала: ${count((a) => a.operationPhase === "Failed" || a.operationPhase === "Error")}`)}
          tone={count((a) => a.operationPhase === "Failed" || a.operationPhase === "Error") ? "bad" : undefined}
        />
      </div>

      <FilterBar count={rows.length} total={apps.length}>
        <Toggle value={problemsOnly} onChange={setProblemsOnly}>
          <Icon name="kube-AlertTriangle" className="size-3.5" />
          {L("Problems only", "Только проблемные")}
        </Toggle>
      </FilterBar>

      <SectionCard
        title={L("Applications", "Приложения")}
        action={uiBase ? (
          <Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
            <a href={uiBase} target="_blank" rel="noreferrer">
              <Icon name="kube-ExternalLink" className="size-3.5" />
              {L("ArgoCD UI", "Интерфейс ArgoCD")}
            </a>
          </Button>
        ) : null}
      >
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{L("No applications match.", "Подходящих приложений нет.")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((a) => {
              const key = `${a.namespace}/${a.name}`;
              const expanded = open === key;
              const running = a.operationPhase === "Running";
              return (
                <li key={key} className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : key)}
                      className="flex min-w-[220px] flex-1 items-center gap-2 text-left"
                    >
                      <Icon name="kube-ChevronRight" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs font-medium">{a.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {a.project} → {a.destNamespace ?? "—"}
                          {a.chart ? ` {L("· chart $", "· чарт $")}{a.chart}` : a.path ? ` · ${a.path}` : ""}
                        </div>
                      </div>
                    </button>
                    <div className="flex w-[220px] flex-wrap items-center gap-2">
                      <StatusPill tone={syncTone(a.sync)}>{a.sync}</StatusPill>
                      <StatusPill tone={healthTone(a.health)}>{a.health}</StatusPill>
                      {a.autoSync ? <Chip title={`selfHeal: ${a.selfHeal}, prune: ${a.prune}`}>{L("auto", "авто")}</Chip> : null}
                    </div>
                    <div className="w-[150px] text-[11px] text-muted-foreground">
                      <div className="truncate font-mono" title={`${a.targetRevision ?? ""} @ ${a.revision ?? ""}`}>
                        {a.targetRevision ?? "HEAD"} @ {short(a.revision) ?? "—"}
                      </div>
                      <div>
                        {running ? (
                          <span className="text-sky-600 dark:text-sky-400">{L("syncing since", "синхронизируется")} {ago(a.operationStartedAt, now)}</span>
                        ) : (
                          <>{L("synced", "синхронизировано")} {ago(a.lastSyncedAt, now)} {L("ago", "назад")}</>
                        )}
                      </div>
                    </div>
                    <div className="ml-auto inline-flex items-center gap-1">
                      {readOnly ? null : (
                        <ActionButton icon="RefreshCcw" label={L("Sync", "Синхронизировать")} hint={L("Sync: apply the git revision to the cluster now (asks first, prune optional)", "Синхронизировать: применить ревизию из git к кластеру (сначала спросит, prune по желанию)")} danger disabled={running} onClick={() => actions.argoSync(a)} />
                      )}
                      <ActionButton icon="RefreshCw" label={L("Refresh", "Обновить")} hint={L("Refresh: re-compare git with the cluster; changes nothing", "Обновить: заново сравнить git с кластером, ничего не меняет")} onClick={() => void actions.argoRefresh(a, false)} />
                      <IconButton icon="Database" label={L("Hard refresh", "Полное обновление")} hint={L("Hard refresh: drop ArgoCD's manifest cache and re-render from git", "Hard refresh: сбросить кеш манифестов ArgoCD и заново собрать их из git")} onClick={() => void actions.argoRefresh(a, true)} />
                      <IconButton
                        icon="Layers"
                        label={L("Show its workloads", "Показать деплойменты")} hint={L("Show the deployments in this app's namespace", "Показать деплойменты в неймспейсе приложения")}
                        onClick={() => {
                          if (a.destNamespace) filters.update({ namespaces: [a.destNamespace] });
                          go("deployments");
                        }}
                      />
                      {uiBase ? (
                        <Hint label={L("Open this application in the ArgoCD web UI", "Открыть приложение в веб-интерфейсе ArgoCD")}>
                          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" asChild>
                            <a href={`${uiBase}/applications/${a.namespace}/${a.name}`} target="_blank" rel="noreferrer" aria-label={L("Open in ArgoCD", "Открыть в ArgoCD")}>
                              <Icon name="kube-ExternalLink" className="size-3.5" />
                            </a>
                          </Button>
                        </Hint>
                      ) : null}
                      <IconButton icon="FileText" label={L("Describe", "Описание")} hint={L("Describe: full kubectl describe output (spec, status, events)", "Описание: полный вывод kubectl describe (spec, status, события)")} onClick={() => actions.describe("applications.argoproj.io", a.namespace, a.name)} />
                    </div>
                  </div>
                  {a.operationPhase === "Failed" || a.operationPhase === "Error" ? (
                    <p className="mt-1 line-clamp-2 pl-5 text-xs text-destructive" title={a.operationMessage ?? undefined}>
                      {L("Last sync", "Последняя синхронизация")}: {a.operationPhase}: {a.operationMessage}
                    </p>
                  ) : null}
                  {a.conditions.length ? (
                    <p className="mt-1 line-clamp-2 pl-5 text-xs text-amber-700 dark:text-amber-300" title={a.conditions.map((c) => c.message).join("\n")}>
                      {a.conditions[0]!.type}: {a.conditions[0]!.message}
                    </p>
                  ) : null}
                  {expanded ? (
                    <div className="mt-2 space-y-2 pl-5 text-xs">
                      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                        <Field label={L("Repository", "Репозиторий")} value={repoLabel(a.repo)} />
                        <Field label={L("Path / chart", "Путь / чарт")} value={a.chart ?? a.path} />
                        <Field label={L("Destination", "Куда")} value={`${a.destServer ?? ""} ${a.destNamespace ?? ""}`} />
                        <Field label={L("Revision", "Ревизия")} value={a.revision} />
                        <Field label={L("Sync policy", "Синхронизация")} value={a.autoSync ? L(`automated${a.selfHeal ? ", self-heal" : ""}${a.prune ? ", prune" : ""}`, `автоматическая${a.selfHeal ? ", self-heal" : ""}${a.prune ? ", prune" : ""}`) : L("manual", "ручная")} />
                        <Field label={L("Reconciled", "Сверено")} value={a.reconciledAt ? L(`${ago(a.reconciledAt, now)} ago`, `${ago(a.reconciledAt, now)} назад`) : null} />
                      </div>
                      {a.healthMessage ? <p className="text-muted-foreground">{a.healthMessage}</p> : null}
                      <div>
                        <div className="mb-1 font-medium">
                          {a.resources.length === 0
                            ? L(`All ${a.resourceCount} resources synced and healthy`, `Все ресурсы (${a.resourceCount}) синхронизированы и здоровы`)
                            : L(`${a.resources.length} of ${a.resourceCount} resources need attention`, `Требуют внимания: ${a.resources.length} из ${a.resourceCount} ресурсов`)}
                        </div>
                        {a.resources.length ? (
                          <ul className="divide-y divide-border rounded-md border border-border">
                            {a.resources.map((r) => (
                              <li key={`${r.kind}/${r.namespace}/${r.name}`} className="flex flex-wrap items-center gap-2 px-2 py-1">
                                <span className="w-28 shrink-0 text-muted-foreground">{r.kind}</span>
                                <span className="min-w-0 flex-1 truncate font-mono" title={r.message ?? undefined}>
                                  {r.namespace ? `${r.namespace}/` : ""}
                                  {r.name}
                                </span>
                                {r.status ? <StatusPill tone={syncTone(r.status)}>{r.status}</StatusPill> : null}
                                {r.health ? <StatusPill tone={healthTone(r.health)}>{r.health}</StatusPill> : null}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                      {a.images.length ? (
                        <div className="flex flex-wrap gap-1">
                          {a.images.slice(0, 12).map((img) => (
                            <Chip key={img}>{img.split("/").at(-1)}</Chip>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono" title={value ?? undefined}>
        {value?.trim() || "—"}
      </span>
    </div>
  );
}
