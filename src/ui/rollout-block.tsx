// Live rollout card for ```kube-rollout fences in chat messages.
//
// An agent that deploys to Kubernetes (or analyses a namespace) writes:
//
//   ```kube-rollout
//   context: my-cluster-prod
//   namespace: platform
//   since: 2026-11-17T17:00:00Z
//   workloads: deployment/app-api, deployment/auth, sts/vault
//   ```
//
// and the chat shows, per workload, whether it has rolled out and whether
// every pod was replaced after `since`, refreshing until it is done.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBbNavigate, useRpc, type ExperimentalCodeFenceRendererProps } from "@get-bb/plugin-sdk/app";
import type { RolloutStatus, RolloutWorkload, rpcContract } from "../contract";
import { parseBlock, type BlockSpec } from "./rollout-parse";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { actions, DialogHost } from "./dialogs";
import { ago, Chip, Dot, dotClass, Hint, IconButton, PANEL_PATH, StatusPill, textClass, useNow, type Tone } from "./shared";
import { filters, setRpcClient } from "./store";
import { L } from "./i18n";

// ---- verdicts -----------------------------------------------------------------------

interface Verdict {
  label: string;
  tone: Tone;
  done: boolean;
  hint: string;
}

function verdict(w: RolloutWorkload, hasSince: boolean): Verdict {
  const fresh = w.pods.filter((p) => p.fresh && p.current).length;
  const live = w.pods.filter((p) => p.status !== "Terminating" && p.status !== "Succeeded").length;
  if (w.state === "missing") return { label: L("Not found", "Не найден"), tone: "bad", done: true, hint: w.message ?? L("No such workload in this namespace", "В этом неймспейсе такого ворклоада нет") };
  if (w.state === "failed") return { label: L("Rollout failed", "Выкат упал"), tone: "bad", done: true, hint: w.message ?? L("Progress deadline exceeded", "Истёк срок выката (progress deadline)") };
  if (w.state === "scaled-to-zero") return { label: L("Scaled to 0", "0 реплик"), tone: "muted", done: true, hint: L("No replicas requested", "Реплики не запрошены") };
  if (hasSince) {
    if (w.restarted === "yes") return { label: L("Restarted", "Перезапущен"), tone: "good", done: true, hint: L(`All ${live} pods were started after the rollout began and run the current revision`, `Все поды (${live}) запущены после начала выката и работают на текущей ревизии`) };
    if (w.restarted === "partial")
      return { label: L(`Restarting ${fresh}/${Math.max(w.desired, live)}`, `Перезапускается ${fresh}/${Math.max(w.desired, live)}`), tone: "info", done: false, hint: L("New pods are coming up; old ones are still running", "Новые поды поднимаются, старые ещё работают") };
    if (w.state === "progressing") return { label: L("Rolling out", "Выкатывается"), tone: "info", done: false, hint: L(`${w.updated}/${w.desired} updated, ${w.ready} ready`, `обновлено ${w.updated}/${w.desired}, готово ${w.ready}`) };
    return { label: L("Not restarted yet", "Ещё не перезапущен"), tone: "warn", done: false, hint: L("Every pod is older than the rollout start time", "Все поды старше времени начала выката") };
  }
  if (w.state === "complete") return { label: L("Rolled out", "Выкачен"), tone: "good", done: true, hint: L("Current revision is fully available", "Текущая ревизия полностью доступна") };
  return { label: L(`Rolling out ${w.updated}/${w.desired}`, `Выкатывается ${w.updated}/${w.desired}`), tone: "info", done: false, hint: L(`${w.ready} ready, ${w.available} available`, `готово ${w.ready}, доступно ${w.available}`) };
}

const short = (img: string | null | undefined) => (img ? img.split("/").at(-1) ?? img : "—");

// ---- component ----------------------------------------------------------------------

export function KubeRolloutBlock(props: ExperimentalCodeFenceRendererProps) {
  const { code, status, Original } = props;
  const parsed = useMemo(() => (status === "streaming" ? null : parseBlock(code)), [code, status]);
  if (status === "streaming" || !parsed) return <Original />;
  if ("error" in parsed) {
    return (
      <div className="space-y-1">
        <Original />
        <p className="text-xs text-destructive">kube-rollout: {parsed.error}</p>
      </div>
    );
  }
  return <RolloutCard spec={parsed} />;
}

export function RolloutCard({ spec }: { spec: BlockSpec }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const now = useNow(5_000);
  const [data, setData] = useState<RolloutStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [context, setContext] = useState<string | null>(spec.context);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => setRpcClient(rpc), [rpc]);

  // No context in the block: use kubectl's current context.
  useEffect(() => {
    if (spec.context) return;
    let cancelled = false;
    rpc.call("contexts", null).then(
      (r) => !cancelled && setContext(r.current ?? r.contexts[0] ?? null),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, spec.context]);

  const load = useCallback(async () => {
    if (!context) return;
    setLoading(true);
    try {
      const next = await rpc.call("rollout_status", {
        context,
        namespace: spec.namespace,
        workloads: spec.workloads,
        ...(spec.since ? { since: spec.since } : {}),
      });
      setData(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [rpc, context, spec]);

  const verdicts = useMemo(
    () => (data ? data.workloads.map((w) => ({ w, v: verdict(w, data.since !== null) })) : []),
    [data],
  );
  const allDone = verdicts.length > 0 && verdicts.every((x) => x.v.done);

  // Poll fast while something is still rolling, slowly once everything is done.
  useEffect(() => {
    if (!context) return;
    void load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      timer = setTimeout(async () => {
        if (document.visibilityState === "visible") await load();
        tick();
      }, allDone ? 60_000 : 5_000);
    };
    tick();
    return () => {
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, allDone, spec]);

  const restartedCount = verdicts.filter((x) => x.v.done && x.v.tone === "good").length;
  const bad = verdicts.filter((x) => x.v.tone === "bad").length;
  const headerTone: Tone = bad ? "bad" : allDone ? "good" : "info";
  const total = verdicts.length;

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const openInPanel = () => {
    filters.update({ namespaces: [spec.namespace], workload: null, node: null, query: "" });
    navigate.toPluginPanel(PANEL_PATH, { subPath: "deployments" });
  };

  return (
    <div className="not-prose my-2 overflow-hidden rounded-lg border border-border bg-card text-sm">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2">
        <Icon name="kube-Ship" className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{spec.title ?? (data?.since ? L("Rollout", "Выкат") : L("Kubernetes status", "Состояние Kubernetes"))}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            <span className="font-mono">{context ?? "…"}</span> · <span className="font-mono">{spec.namespace}</span>
            {spec.since ? L(` · started ${ago(spec.since, now)} ago`, ` · начат ${ago(spec.since, now)} назад`) : ""}
            {data ? L(` · checked ${ago(data.fetchedAt, now)} ago`, ` · проверено ${ago(data.fetchedAt, now)} назад`) : ""}
          </div>
        </div>
        {total > 0 ? (
          <Hint label={spec.since ? L("Workloads whose pods were all replaced after the start time", "Ворклоады, у которых все поды заменены после начала") : L("Workloads fully rolled out", "Полностью выкаченные ворклоады")}>
            <span className={cn("text-xs font-medium tabular-nums", textClass[headerTone])}>
              {restartedCount}/{total} {spec.since ? L("restarted", "перезапущено") : L("rolled out", "выкачено")}
              {bad ? L(` · ${bad} failed`, ` · упало: ${bad}`) : ""}
            </span>
          </Hint>
        ) : null}
        <IconButton
          icon="RefreshCw"
          label={L("Refresh", "Обновить")}
          hint={allDone ? L("Check again now (auto-checks every minute)", "Проверить сейчас (сама проверяет раз в минуту)") : L("Check again now (auto-checks every 5 s while rolling out)", "Проверить сейчас (пока идёт выкат, проверяет каждые 5 с)")}
          onClick={() => void load()}
        />
        <IconButton icon="ExternalLink" label={L("Open in Kubernetes", "Открыть в Kubernetes")} hint={L("Open this namespace in the Kubernetes panel", "Открыть этот неймспейс в панели Kubernetes")} onClick={openInPanel} />
      </header>
      {total > 0 ? (
        <div className="flex h-1 w-full bg-muted">
          {verdicts.map(({ w, v }) => (
            <div key={`${w.kind}/${w.name}`} className={cn("h-full flex-1 border-r border-card last:border-r-0", dotClass[v.tone])} />
          ))}
        </div>
      ) : null}

      {error ? <p className="whitespace-pre-wrap px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {!data && !error ? (
        <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <Icon name="kube-RefreshCw" className={cn("size-3.5", loading && "animate-spin")} /> {L("Reading the cluster…", "Читаю кластер…")}
        </p>
      ) : null}

      {data ? (
        <ul className="divide-y divide-border">
          {verdicts.map(({ w, v }) => {
            const key = `${w.kind}/${w.name}`;
            const expanded = open.has(key);
            const fresh = w.pods.filter((p) => p.fresh && p.current).length;
            return (
              <li key={key}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => toggle(key)}
                    className="flex min-w-[200px] flex-1 items-center gap-2 text-left"
                  >
                    <Icon name="kube-ChevronRight" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs font-medium">{w.name}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {w.kind}
                        {w.found ? ` · rev ${w.revision && w.revision.length > 12 ? w.revision.slice(-10) : w.revision ?? "?"} · ${short(w.images[0])}` : ""}
                      </div>
                    </div>
                  </button>
                  <Hint label={v.hint}>
                    <span className="inline-flex w-[150px]">
                      <StatusPill tone={v.tone}>{v.label}</StatusPill>
                    </span>
                  </Hint>
                  <Hint label={L(`${w.ready} ready of ${w.desired} desired · ${w.updated} on the new revision`, `готово ${w.ready} из ${w.desired} · на новой ревизии ${w.updated}`)}>
                    <span className="w-14 font-mono text-xs tabular-nums">
                      {w.ready}/{w.desired}
                    </span>
                  </Hint>
                  {data.since ? (
                    <Hint label={L("Pods started after the rollout began, on the current revision", "Поды, запущенные после начала выката, на текущей ревизии")}>
                      <span className="w-20 text-xs tabular-nums text-muted-foreground">
                        {L(`${fresh}/${w.pods.length} new`, `новых ${fresh}/${w.pods.length}`)}
                      </span>
                    </Hint>
                  ) : (
                    <Hint label={L("Last `kubectl rollout restart`", "Последний `kubectl rollout restart`")}>
                      <span className="w-24 text-xs text-muted-foreground">{w.restartedAt ? L(`restart ${ago(w.restartedAt, now)} ago`, `перезапуск ${ago(w.restartedAt, now)} назад`) : ""}</span>
                    </Hint>
                  )}
                  {w.found && w.selector ? (
                    <IconButton
                      icon="ScrollText"
                      label={L("Logs", "Логи")}
                      hint={L("Logs from all its pods, merged by time", "Логи всех его подов, по времени")}
                      onClick={() =>
                        actions.refLogs({ kind: "selector", context: data.context, namespace: data.namespace, title: `${w.kind} ${w.name}`, selector: w.selector! })
                      }
                    />
                  ) : null}
                </div>
                {w.message && v.tone === "bad" ? <p className="px-9 pb-2 text-xs text-destructive">{w.message}</p> : null}
                {expanded ? (
                  <ul className="mx-3 mb-2 divide-y divide-border rounded-md border border-border">
                    {w.pods.length === 0 ? <li className="px-2 py-1.5 text-xs text-muted-foreground">{L("No pods.", "Подов нет.")}</li> : null}
                    {w.pods.map((p) => {
                      const tone: Tone = !p.healthy ? (p.status === "Running" || p.status === "ContainerCreating" || p.status === "Pending" ? "warn" : "bad") : "good";
                      return (
                        <li key={p.name} className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs">
                          <Dot tone={tone} />
                          <span className="min-w-0 flex-1 truncate font-mono" title={p.node ?? undefined}>
                            {p.name}
                          </span>
                          {p.fresh === null ? (
                            p.current ? null : <Chip tone="warn">{L("old revision", "старая ревизия")}</Chip>
                          ) : p.fresh && p.current ? (
                            <Hint label={L("Started after the rollout began, on the current revision", "Запущен после начала выката, на текущей ревизии")}>
                              <span><Chip tone="good">{L("new", "новый")}</Chip></span>
                            </Hint>
                          ) : (
                            <Hint label={p.current ? L("Current revision, but started before the rollout began", "Текущая ревизия, но запущен до начала выката") : L("Old revision: will be replaced", "Старая ревизия: будет заменён")}>
                              <span><Chip tone="warn">{L("old", "старый")}</Chip></span>
                            </Hint>
                          )}
                          <span className="w-28 text-right">{p.status}</span>
                          <span className="w-10 text-right font-mono tabular-nums">{p.ready}</span>
                          <Hint label={p.lastRestartAt ? L(`Last container restart ${ago(p.lastRestartAt, now)} ago`, `Последний перезапуск контейнера ${ago(p.lastRestartAt, now)} назад`) : L("Container restarts", "Перезапуски контейнеров")}>
                            <span className={cn("w-10 text-right tabular-nums", p.restarts > 0 && textClass.warn)}>↻{p.restarts}</span>
                          </Hint>
                          <Hint label={L(`Pod started ${new Date(p.createdAt).toLocaleString()}`, `Под запущен ${new Date(p.createdAt).toLocaleString()}`)}>
                            <span className="w-12 text-right tabular-nums text-muted-foreground">{ago(p.createdAt, now)}</span>
                          </Hint>
                          <IconButton
                            icon="ScrollText"
                            label={L("Logs", "Логи")}
                            hint={L("Show this pod's logs", "Показать логи пода")}
                            onClick={() => actions.refLogs({ kind: "podRef", context: data.context, namespace: data.namespace, name: p.name })}
                          />
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
          {verdicts.length === 0 ? <li className="px-3 py-3 text-xs text-muted-foreground">{L("No workloads in", "В")} {spec.namespace} {L(".", "нет ворклоадов.")}</li> : null}
        </ul>
      ) : null}
      <DialogHost />
    </div>
  );
}
