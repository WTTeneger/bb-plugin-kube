// Dialogs and the actions that open them. A module-level store lets any row
// open a dialog without threading callbacks through every section.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { ArgoApp, Job, Pod, PortForward, Service, Workload } from "../contract";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { NativeSelect } from "./shared";
import { core, getRpc, portForwards } from "./store";
import { L } from "./i18n";

// ---------------------------------------------------------------------------
// Dialog + toast store
// ---------------------------------------------------------------------------

type LogSource =
  | { kind: "pod"; pod: Pod }
  | { kind: "workload"; workload: Workload }
  /** From a chat block: explicit context, no full Pod/Workload object. */
  | { kind: "podRef"; context: string; namespace: string; name: string }
  | { kind: "selector"; context: string; namespace: string; title: string; selector: string };

export type DialogState =
  | { kind: "logs"; source: LogSource }
  | { kind: "text"; title: string; subtitle: string; load: () => Promise<string> }
  | { kind: "confirm"; title: string; body: ReactNode; action: string; run: (opts: { prune: boolean }) => Promise<string>; extra?: "prune" }
  | { kind: "portforward"; target: PortForwardTarget }
  | null;

export interface PortForwardTarget {
  namespace: string;
  kind: PortForward["kind"];
  name: string;
  ports: { port: number; label: string }[];
}

const ui = (() => {
  let state: { dialog: DialogState; toast: { text: string; tone: "ok" | "error" } | null } = { dialog: null, toast: null };
  const listeners = new Set<() => void>();
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const set = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };
  return {
    get: () => state,
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    open(dialog: DialogState) {
      set({ dialog });
    },
    close() {
      set({ dialog: null });
    },
    toast(text: string, tone: "ok" | "error" = "ok") {
      if (toastTimer) clearTimeout(toastTimer);
      set({ toast: { text, tone } });
      toastTimer = setTimeout(() => set({ toast: null }), tone === "error" ? 7000 : 4000);
    },
  };
})();
export const toast = ui.toast;

const ctx = () => {
  const c = core.get().config?.selection?.context;
  if (!c) throw new Error(L("No context selected.", "Контекст не выбран."));
  return c;
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const actions = {
  podLogs(pod: Pod) {
    ui.open({ kind: "logs", source: { kind: "pod", pod } });
  },
  workloadLogs(workload: Workload) {
    if (!workload.selector) {
      ui.toast(L(`${workload.name} has no label selector`, `У ${workload.name} нет селектора меток`), "error");
      return;
    }
    ui.open({ kind: "logs", source: { kind: "workload", workload } });
  },
  /** Logs for a block in chat, which names its own context. */
  refLogs(source: Extract<LogSource, { kind: "podRef" | "selector" }>) {
    ui.open({ kind: "logs", source });
  },
  describe(kind: string, namespace: string, name: string) {
    ui.open({
      kind: "text",
      title: `${kind} ${namespace ? `${namespace}/` : ""}${name}`,
      subtitle: "kubectl describe",
      load: async () =>
        (
          await getRpc().call("describe", {
            context: ctx(),
            namespace: namespace || "default",
            name,
            kind: kind.toLowerCase() as never,
          })
        ).text,
    });
  },
  restartPod(pod: Pod) {
    ui.open({
      kind: "confirm",
      title: L("Restart pod?", "Перезапустить под?"),
      action: L("Restart pod", "Перезапустить под"),
      body: (
        <p>
          <span className="font-mono text-foreground">{pod.namespace}/{pod.name}</span> {L("will be deleted.", "будет удалён.")}
          {pod.owner
            ? L(` Its controller (${pod.owner}) creates a replacement.`, ` Его контроллер (${pod.owner}) создаст новый.`)
            : L(" It has no controller, so it will NOT be recreated.", " У него нет контроллера, он НЕ будет пересоздан.")}
        </p>
      ),
      run: async () => (await getRpc().call("pod_restart", { context: ctx(), namespace: pod.namespace, name: pod.name })).message,
    });
  },
  rolloutRestart(w: Workload) {
    ui.open({
      kind: "confirm",
      title: L(`Restart ${w.kind}?`, `Перезапустить ${w.kind}?`),
      action: "Rollout restart",
      body: (
        <p>
          {L("Runs", "Выполнит")} <code>kubectl rollout restart</code> {L("on", "для")}{" "}
          <span className="font-mono text-foreground">{w.namespace}/{w.name}</span>{L(": pods are replaced one by one following its update strategy.", ": поды заменяются по одному согласно стратегии обновления.")}
        </p>
      ),
      run: async () =>
        (await getRpc().call("rollout_restart", { context: ctx(), namespace: w.namespace, name: w.name, kind: w.kind })).message,
    });
  },
  scale(w: Workload, replicas: number) {
    if (w.kind === "DaemonSet") return;
    ui.open({
      kind: "confirm",
      title: L(`Scale ${w.kind}?`, `Масштабировать ${w.kind}?`),
      action: L(`Scale to ${replicas}`, `Сделать ${replicas}`),
      body: (
        <p>
          <span className="font-mono text-foreground">{w.namespace}/{w.name}</span>: {w.desired} → {replicas} {L("replicas.", "реплик.")}
        </p>
      ),
      run: async () =>
        (
          await getRpc().call("scale", {
            context: ctx(),
            namespace: w.namespace,
            name: w.name,
            kind: w.kind as "Deployment" | "StatefulSet",
            replicas,
          })
        ).message,
    });
  },
  trigger(j: Job) {
    ui.open({
      kind: "confirm",
      title: L("Run CronJob now?", "Запустить CronJob сейчас?"),
      action: L("Create job", "Создать Job"),
      body: (
        <p>
          {L("Creates a one-off Job from", "Создаст разовый Job из")} <span className="font-mono text-foreground">{j.namespace}/{j.name}</span>.
        </p>
      ),
      run: async () => (await getRpc().call("cronjob_trigger", { context: ctx(), namespace: j.namespace, name: j.name })).message,
    });
  },
  argoSync(app: ArgoApp) {
    ui.open({
      kind: "confirm",
      title: L(`Sync ${app.name}?`, `Синхронизировать ${app.name}?`),
      action: L("Sync", "Синхронизировать"),
      extra: "prune",
      body: (
        <div className="space-y-1">
          <p>
            {L("ArgoCD applies", "ArgoCD применит")} <span className="font-mono text-foreground">{app.targetRevision ?? "HEAD"}</span>
            {app.path ? (
              <>
                {" "}
                {L("of", "из")} <span className="font-mono text-foreground">{app.path}</span>
              </>
            ) : null}{" "}
            {L("to", "в")} <span className="font-mono text-foreground">{app.destNamespace ?? L("its destination", "целевой неймспейс")}</span>.
          </p>
          <p>
            {L("Status now:", "Сейчас:")} {app.sync}, {app.health}.
          </p>
        </div>
      ),
      run: async ({ prune }) =>
        (await getRpc().call("argocd_sync", { context: ctx(), namespace: app.namespace, name: app.name, prune })).message,
    });
  },
  async argoRefresh(app: ArgoApp, hard: boolean) {
    try {
      const { message } = await getRpc().call("argocd_refresh", {
        context: ctx(),
        namespace: app.namespace,
        name: app.name,
        hard,
      });
      ui.toast(message);
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error");
    }
  },
  portForward(target: PortForwardTarget) {
    ui.open({ kind: "portforward", target });
  },
  podPortForward(pod: Pod) {
    const ports = pod.containers.flatMap((c) =>
      c.ports
        .filter((p) => p.protocol === "TCP")
        .map((p) => ({ port: p.port, label: `${p.port}${p.name ? ` (${p.name})` : ""} · ${c.name}` })),
    );
    actions.portForward({ namespace: pod.namespace, kind: "pod", name: pod.name, ports });
  },
  servicePortForward(s: Service) {
    const ports = s.ports
      .filter((p) => p.protocol === "TCP")
      .map((p) => ({ port: p.port, label: `${p.port}${p.name ? ` (${p.name})` : ""}${p.targetPort ? ` → ${p.targetPort}` : ""}` }));
    actions.portForward({ namespace: s.namespace, kind: "service", name: s.name, ports });
  },
  workloadPortForward(w: Workload, pods: Pod[]) {
    const pod = pods.find((p) => p.healthy) ?? pods[0];
    const ports = pod
      ? pod.containers.flatMap((c) => c.ports.filter((p) => p.protocol === "TCP").map((p) => ({ port: p.port, label: `${p.port}${p.name ? ` (${p.name})` : ""} · ${c.name}` })))
      : [];
    if (w.kind === "DaemonSet") {
      if (pod) actions.podPortForward(pod);
      return;
    }
    actions.portForward({ namespace: w.namespace, kind: w.kind === "Deployment" ? "deployment" : "statefulset", name: w.name, ports });
  },
  async stopPortForward(id: string) {
    try {
      await getRpc().call("pf_stop", { id });
      void portForwards.refresh();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error");
    }
  },
};

// ---------------------------------------------------------------------------
// Host: render the open dialog and the toast (mount once, in the page)
// ---------------------------------------------------------------------------

// Several hosts can be mounted at once (the panel page and every chat block);
// only the first one renders, so a dialog never opens twice.
const hostOwners: symbol[] = [];
const hostListeners = new Set<() => void>();
function useIsHostOwner(): boolean {
  const [me] = useState(() => Symbol("dialog-host"));
  useEffect(() => {
    hostOwners.push(me);
    for (const l of hostListeners) l();
    return () => {
      hostOwners.splice(hostOwners.indexOf(me), 1);
      for (const l of hostListeners) l();
    };
  }, [me]);
  return useSyncExternalStore(
    (l) => {
      hostListeners.add(l);
      return () => {
        hostListeners.delete(l);
      };
    },
    () => hostOwners[0] === me,
    () => false,
  );
}

export function DialogHost() {
  const { dialog, toast } = useSyncExternalStore(ui.subscribe, ui.get, ui.get);
  const owner = useIsHostOwner();
  if (!owner) return null;
  return (
    <>
      {dialog?.kind === "logs" ? <LogViewer source={dialog.source} onClose={ui.close} /> : null}
      {dialog?.kind === "text" ? <TextViewer title={dialog.title} subtitle={dialog.subtitle} load={dialog.load} onClose={ui.close} /> : null}
      {dialog?.kind === "confirm" ? <ConfirmDialog state={dialog} /> : null}
      {dialog?.kind === "portforward" ? <PortForwardDialog target={dialog.target} /> : null}
      {toast ? (
        <div
          role="status"
          className={cn(
            "fixed bottom-4 right-4 z-50 max-w-sm whitespace-pre-wrap rounded-lg border bg-card px-3 py-2 text-sm shadow-lg",
            toast.tone === "error" ? "border-destructive/50 text-destructive" : "border-border",
          )}
        >
          {toast.text}
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Text / log viewers
// ---------------------------------------------------------------------------

function ViewerShell({
  title,
  subtitle,
  controls,
  text,
  error,
  onReload,
  onClose,
  stickToBottom,
}: {
  title: string;
  subtitle: ReactNode;
  controls?: ReactNode;
  text: string | null;
  error: string | null;
  onReload: () => void;
  onClose: () => void;
  stickToBottom?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    if (text === null || filter.trim() === "") return text;
    const needle = filter.toLowerCase();
    return text
      .split("\n")
      .filter((l) => l.toLowerCase().includes(needle))
      .join("\n");
  }, [text, filter]);
  useEffect(() => {
    if (stickToBottom && shown !== null && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [shown, stickToBottom]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[88vh] w-[min(1200px,96vw)] max-w-none flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="truncate font-mono text-sm">{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          {controls}
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={L("Filter lines…", "Фильтр строк…")} className="h-8 max-w-xs text-xs" aria-label={L("Filter lines", "Фильтр строк")} />
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={onReload}>
            <Icon name="kube-RefreshCw" className="size-3.5" />
            {L("Reload", "Перезагрузить")}
          </Button>
          <Button variant="outline" size="sm" disabled={shown === null} onClick={() => void navigator.clipboard.writeText(shown ?? "")}>
            <Icon name="kube-Copy" className="size-3.5" />
            {L("Copy", "Копировать")}
          </Button>
        </div>
        <div ref={scrollRef} className="min-h-[240px] flex-1 overflow-auto rounded-md border border-border bg-muted/40">
          {error ? (
            <p className="whitespace-pre-wrap p-3 text-sm text-destructive">{error}</p>
          ) : shown === null ? (
            <p className="p-3 text-sm text-muted-foreground">{L("Loading…", "Загрузка…")}</p>
          ) : (
            <pre className="whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-relaxed">{shown || L("(empty)", "(пусто)")}</pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function useLoader(load: () => Promise<string>, deps: unknown[]) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    load().then(
      (t) => !cancelled && setText(t),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { text, error, reload: () => setNonce((n) => n + 1) };
}

function TextViewer({ title, subtitle, load, onClose }: { title: string; subtitle: string; load: () => Promise<string>; onClose: () => void }) {
  const { text, error, reload } = useLoader(load, [load]);
  return <ViewerShell title={title} subtitle={subtitle} text={text} error={error} onReload={reload} onClose={onClose} />;
}

const TAILS = ["200", "1000", "5000"];

function LogViewer({ source, onClose }: { source: LogSource; onClose: () => void }) {
  const [container, setContainer] = useState("");
  const [previous, setPrevious] = useState(false);
  const [tail, setTail] = useState("1000");
  const isPod = source.kind === "pod" || source.kind === "podRef";
  const { text, error, reload } = useLoader(async () => {
    const rpc = getRpc();
    if (source.kind === "podRef") {
      return (
        await rpc.call("pod_logs", {
          context: source.context,
          namespace: source.namespace,
          name: source.name,
          previous,
          tail: Number(tail),
        })
      ).text;
    }
    if (source.kind === "selector") {
      return (
        await rpc.call("workload_logs", {
          context: source.context,
          namespace: source.namespace,
          name: source.title.split(" ").at(-1)!,
          selector: source.selector,
          tail: Math.min(2000, Number(tail)),
        })
      ).text;
    }
    if (source.kind === "pod") {
      return (
        await rpc.call("pod_logs", {
          context: ctx(),
          namespace: source.pod.namespace,
          name: source.pod.name,
          ...(container ? { container } : {}),
          previous,
          tail: Number(tail),
        })
      ).text;
    }
    return (
      await rpc.call("workload_logs", {
        context: ctx(),
        namespace: source.workload.namespace,
        name: source.workload.name,
        selector: source.workload.selector!,
        tail: Math.min(2000, Number(tail)),
      })
    ).text;
  }, [source, container, previous, tail]);

  const title =
    source.kind === "pod"
      ? `${source.pod.namespace}/${source.pod.name}`
      : source.kind === "workload"
        ? `${source.workload.kind} ${source.workload.namespace}/${source.workload.name}`
        : source.kind === "podRef"
          ? `${source.namespace}/${source.name} · ${source.context}`
          : `${source.title} · ${source.context}`;
  const subtitle = isPod
    ? L(`Last ${tail} lines${previous ? " of the previous container" : ""}`, `Последние ${tail} строк${previous ? " предыдущего контейнера" : ""}`)
    : L(`Last ${Math.min(2000, Number(tail))} lines from each pod, merged by time`, `Последние ${Math.min(2000, Number(tail))} строк каждого пода, по времени`);
  return (
    <ViewerShell
      title={title}
      subtitle={subtitle}
      text={text}
      error={error}
      onReload={reload}
      onClose={onClose}
      stickToBottom
      controls={
        <>
          <NativeSelect className="w-28" label={L("Lines", "Строк")} value={tail} onChange={setTail} options={TAILS.map((t) => ({ value: t, label: L(`${t} lines`, `${t} строк`) }))} />
          {source.kind === "pod" && source.pod.containers.length > 1 ? (
            <NativeSelect
              className="w-44"
              value={container}
              onChange={setContainer}
              options={[{ value: "", label: L("All containers", "Все контейнеры") }, ...source.pod.containers.map((c) => ({ value: c.name, label: c.name }))]}
              label={L("Container", "Контейнер")}
            />
          ) : null}
          {isPod ? (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} />
              {L("Previous container", "Предыдущий контейнер")}
            </label>
          ) : null}
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

function ConfirmDialog({ state }: { state: Extract<DialogState, { kind: "confirm" }> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prune, setPrune] = useState(false);
  const context = core.get().config?.selection?.context ?? "";
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && ui.close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{state.title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm">
              {state.body}
              <p className="text-xs">
                {L("Context:", "Контекст:")} <span className="font-mono font-medium text-foreground">{context}</span>
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        {state.extra === "prune" ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />
            {L("Prune resources that are no longer in git", "Удалить ресурсы, которых больше нет в git (prune)")}
          </label>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={ui.close}>
            {L("Cancel", "Отмена")}
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                const message = await state.run({ prune });
                ui.close();
                if (message) ui.toast(message);
                void core.refresh({ force: true });
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setPending(false);
              }
            }}
          >
            {pending ? L("Working…", "Выполняется…") : state.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Port-forward
// ---------------------------------------------------------------------------

function PortForwardDialog({ target }: { target: PortForwardTarget }) {
  const [remote, setRemote] = useState(target.ports[0] ? String(target.ports[0].port) : "");
  const [local, setLocal] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PortForward | null>(null);
  const remoteNum = Number(remote);
  const localNum = local.trim() === "" ? 0 : Number(local);
  const valid =
    Number.isInteger(remoteNum) && remoteNum >= 1 && remoteNum <= 65535 &&
    Number.isInteger(localNum) && localNum >= 0 && localNum <= 65535;

  const start = async () => {
    setPending(true);
    setError(null);
    try {
      const pf = await getRpc().call("pf_start", {
        context: ctx(),
        namespace: target.namespace,
        name: target.name,
        kind: target.kind,
        remotePort: remoteNum,
        ...(localNum ? { localPort: localNum } : {}),
      });
      void portForwards.refresh();
      if (pf.status === "error") setError(pf.error ?? L("port-forward failed", "проброс порта не удался"));
      else setResult(pf);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  const url = result?.localPort ? `http://localhost:${result.localPort}` : null;

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && ui.close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{L("Port-forward", "Проброс порта")}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-foreground">
              {target.kind}/{target.namespace}/{target.name}
            </span>{" "}
            {L("to", "на")} <span className="font-mono">127.0.0.1</span> {L("on this machine. It runs until you stop it or bb reloads the plugin.", "этой машины. Работает, пока вы его не остановите или bb не перезапустит плагин.")}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-3 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
            <p>
              {L("Forwarding", "Проброшено")} <span className="font-mono">127.0.0.1:{result.localPort}</span> {L("→ port", "→ порт")} {result.remotePort}
            </p>
            {url ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" asChild>
                  <a href={url} target="_blank" rel="noreferrer">
                    <Icon name="kube-ExternalLink" className="size-3.5" />
                    {L("Open", "Открыть")} {url}
                  </a>
                </Button>
                <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(`localhost:${result.localPort}`)}>
                  <Icon name="kube-Copy" className="size-3.5" />
                  {L("Copy address", "Копировать адрес")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground">{L("Remote port", "Порт в кластере")}</span>
              {target.ports.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {target.ports.map((p) => (
                    <Button
                      key={`${p.port}-${p.label}`}
                      size="sm"
                      variant="outline"
                      aria-pressed={remote === String(p.port)}
                      className="h-7 px-2 font-mono text-xs aria-pressed:bg-state-active"
                      onClick={() => setRemote(String(p.port))}
                    >
                      {p.label}
                    </Button>
                  ))}
                </div>
              ) : null}
              <Input value={remote} onChange={(e) => setRemote(e.target.value.replace(/\D/g, ""))} placeholder={L("e.g. 8080", "например, 8080")} className="h-8 font-mono text-xs" aria-label={L("Remote port", "Порт в кластере")} />
            </div>
            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground">{L("Local port (empty picks a free one)", "Локальный порт (пусто — выбрать свободный)")}</span>
              <Input value={local} onChange={(e) => setLocal(e.target.value.replace(/\D/g, ""))} placeholder={L("auto", "авто")} className="h-8 font-mono text-xs" aria-label={L("Local port", "Локальный порт")} />
            </div>
          </div>
        )}
        {error ? <p className="whitespace-pre-wrap text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={ui.close}>
            {result ? L("Done", "Готово") : L("Cancel", "Отмена")}
          </Button>
          {result ? null : (
            <Button disabled={pending || !valid} onClick={() => void start()}>
              {pending ? L("Starting…", "Запуск…") : L("Start", "Запустить")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
