// bb-plugin-kube — Kubernetes overview and controls for bb.
//
// The server shells out to `kubectl` (always with an explicit --context), so
// whatever auth the user's kubeconfig uses (exec plugins such as doctl, aws,
// gke-gcloud-auth-plugin) keeps working. The selected context/namespace lives
// in plugin storage, never in the kubeconfig: the plugin does not change the
// user's current-context.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  ALL_NAMESPACES,
  nameSchema,
  rolloutInputSchema,
  rpcContract,
  selectionSchema,
  targetSchema,
  type Argo,
  type Metrics,
  type Pvc,
  type Selection,
  type Snapshot,
  type Storage,
  type Target,
  type Workload,
} from "./src/contract";
import {
  parseArgoApp,
  parseCpu,
  parseEvent,
  parseIngress,
  parseJob,
  parseMem,
  parseNode,
  parsePod,
  parsePv,
  parsePvc,
  parseService,
  parseStorageClass,
  parseWorkload,
} from "./src/parse";
import { createPortForwards } from "./src/portforward";
import { rolloutStatus } from "./src/rollout";

export { rpcContract };
export type * from "./src/contract";

/** Realtime channels the UI listens on. */
const CHANGED = "kube-changed";
const PF_CHANGED = "kube-pf-changed";

class KubectlError extends Error {}

function buildEnv(kubeconfig: string): NodeJS.ProcessEnv {
  // A GUI-launched server may miss Homebrew / user bins, which kubectl exec
  // credential plugins (doctl, aws, gcloud) need.
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local/bin"),
    join(homedir(), "google-cloud-sdk/bin"),
  ];
  const path = [...(process.env.PATH ?? "").split(delimiter), ...extra]
    .filter((part, index, all) => part !== "" && all.indexOf(part) === index)
    .join(delimiter);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path };
  if (kubeconfig !== "") env.KUBECONFIG = kubeconfig.replace(/^~/, homedir());
  return env;
}

function resolveKubectl(setting: string, env: NodeJS.ProcessEnv): string {
  if (setting !== "") return setting.replace(/^~/, homedir());
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "kubectl");
    if (existsSync(candidate)) return candidate;
  }
  return "kubectl";
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    kubectlPath: {
      type: "string",
      label: "kubectl path",
      description: "Leave empty to find kubectl on PATH (Homebrew included).",
      default: "",
    },
    kubeconfig: {
      type: "string",
      label: "KUBECONFIG",
      description:
        "Optional kubeconfig path(s), separated by ':'. Empty uses kubectl's default (~/.kube/config).",
      default: "",
    },
    readOnly: {
      type: "boolean",
      label: "Read-only mode",
      description: "Hide and refuse restarts, scaling, job triggers and ArgoCD syncs.",
      default: false,
    },
    refreshSeconds: {
      type: "number",
      label: "Auto-refresh interval (seconds)",
      description: "How often an open Kubernetes page refreshes. 0 turns it off.",
      default: 15,
    },
    language: {
      type: "select",
      label: "Interface language",
      description: "Language of the Kubernetes panel and chat cards. Also switchable from the panel toolbar.",
      options: ["en", "ru"],
      experimental_optionLabels: { en: "English", ru: "Русский" },
      default: "en",
    },
  });
  const config = await settings.get();
  const env = buildEnv(config.kubeconfig);
  const kubectlBin = resolveKubectl(config.kubectlPath, env);
  const readOnly = config.readOnly;
  const refreshSeconds = Math.max(0, Math.floor(config.refreshSeconds));
  // The UI language can change at runtime (panel toggle or settings page).
  let language: "en" | "ru" = config.language === "ru" ? "ru" : "en";
  settings.onChange((next) => {
    const lang = next.language === "ru" ? "ru" : "en";
    if (lang !== language) {
      language = lang;
      bb.realtime.publish("kube-changed", { at: Date.now() });
    }
  });
  const disposed = new AbortController();

  const portForwards = createPortForwards({
    kubectlBin,
    env,
    onChange: () => bb.realtime.publish(PF_CHANGED, { at: Date.now() }),
    log: (m) => bb.log.info(m),
  });
  bb.onDispose(() => {
    disposed.abort();
    portForwards.disposeAll();
  });

  function kubectl(
    args: string[],
    options: { timeoutMs?: number; maxBuffer?: number } = {},
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        kubectlBin,
        args,
        {
          env,
          timeout: options.timeoutMs ?? 25_000,
          maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
          signal: disposed.signal,
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || error.message)
              .trim()
              .split("\n")
              .slice(-4)
              .join("\n");
            const enoent = (error as NodeJS.ErrnoException).code === "ENOENT";
            reject(
              new KubectlError(
                enoent
                  ? `kubectl not found (${kubectlBin}). Set "kubectl path" in the plugin settings.`
                  : detail || "kubectl failed",
              ),
            );
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  async function getJson(context: string, resource: string, namespace: string): Promise<unknown[]> {
    const scope = namespace === ALL_NAMESPACES ? ["-A"] : ["-n", namespace];
    const out = await kubectl([
      "--context", context, "--request-timeout=20s",
      "get", resource, ...scope, "-o", "json",
    ]);
    const parsed = JSON.parse(out) as { items?: unknown[] };
    return parsed.items ?? [];
  }

  async function getClusterJson(context: string, resource: string): Promise<unknown[]> {
    const out = await kubectl([
      "--context", context, "--request-timeout=20s", "get", resource, "-o", "json",
    ]);
    return (JSON.parse(out) as { items?: unknown[] }).items ?? [];
  }

  // ---- contexts & selection ----------------------------------------------

  async function listContexts(): Promise<{ contexts: string[]; current: string | null }> {
    const out = await kubectl(["config", "get-contexts", "-o", "name"], { timeoutMs: 10_000 });
    const contexts = out.split("\n").map((s) => s.trim()).filter(Boolean);
    let current: string | null = null;
    try {
      current = (await kubectl(["config", "current-context"], { timeoutMs: 10_000 })).trim();
    } catch {
      current = null;
    }
    return { contexts, current: current || null };
  }

  async function readSelection(): Promise<Selection | null> {
    const stored = await bb.storage.kv.get<Selection>("selection");
    const parsed = selectionSchema.safeParse(stored);
    return parsed.success ? parsed.data : null;
  }

  async function effectiveSelection(): Promise<Selection> {
    const stored = await readSelection();
    if (stored) return stored;
    const { contexts, current } = await listContexts();
    const context = current ?? contexts[0];
    if (!context) throw new KubectlError("No kubeconfig contexts found.");
    const selection = { context, namespace: ALL_NAMESPACES };
    await bb.storage.kv.set("selection", selection);
    return selection;
  }

  // ---- short per-selection caches -------------------------------------------

  function cached<T>(ttlMs: number, load: (s: Selection) => Promise<T>) {
    let entry: { key: string; at: number; value: Promise<T> } | null = null;
    const get = async (force = false): Promise<T> => {
      const selection = await effectiveSelection();
      const key = `${selection.context}\u0000${selection.namespace}`;
      if (!force && entry && entry.key === key && Date.now() - entry.at < ttlMs) return entry.value;
      const value = load(selection);
      entry = { key, at: Date.now(), value };
      value.catch(() => {
        if (entry?.value === value) entry = null;
      });
      return value;
    };
    return { get, clear: () => (entry = null) };
  }

  // ---- snapshot ------------------------------------------------------------

  async function loadSnapshot(selection: Selection): Promise<Snapshot> {
    const { context, namespace } = selection;
    const errors: string[] = [];
    const safe = async (resource: string, ns: string): Promise<unknown[]> => {
      try {
        return await getJson(context, resource, ns);
      } catch (error) {
        errors.push(`${resource}: ${(error as Error).message}`);
        return [];
      }
    };
    const [pods, deployments, statefulsets, daemonsets, jobs, cronjobs, services, ingresses, nodes, events] =
      await Promise.all([
        safe("pods", namespace),
        safe("deployments.apps", namespace),
        safe("statefulsets.apps", namespace),
        safe("daemonsets.apps", namespace),
        safe("jobs.batch", namespace),
        safe("cronjobs.batch", namespace),
        safe("services", namespace),
        safe("ingresses.networking.k8s.io", namespace),
        safe("nodes", ALL_NAMESPACES),
        safe("events", namespace),
      ]);
    if (errors.length === 10) throw new KubectlError(errors[0]!.replace(/^pods: /, ""));
    const parsedPods = pods.map(parsePod);
    const podsPerNode = new Map<string, number>();
    for (const pod of parsedPods) {
      if (pod.node && !pod.terminated) podsPerNode.set(pod.node, (podsPerNode.get(pod.node) ?? 0) + 1);
    }
    return {
      selection,
      fetchedAt: new Date().toISOString(),
      pods: parsedPods,
      workloads: [...deployments, ...statefulsets, ...daemonsets].map(parseWorkload),
      jobs: [...cronjobs, ...jobs].map(parseJob),
      services: services.map(parseService),
      ingresses: ingresses.map(parseIngress),
      nodes: nodes.map((n) =>
        parseNode(n, podsPerNode.get((n as { metadata?: { name?: string } }).metadata?.name ?? "") ?? 0),
      ),
      events: events
        .map(parseEvent)
        .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))
        .slice(0, 300),
      errors: [...new Set(errors)].slice(0, 10),
    };
  }
  const snapshotCache = cached(5_000, loadSnapshot);

  // ---- metrics (kubectl top) ---------------------------------------------------

  async function loadMetrics(selection: Selection): Promise<Metrics> {
    const { context, namespace } = selection;
    const fetchedAt = new Date().toISOString();
    try {
      const [nodesOut, podsOut] = await Promise.all([
        kubectl(["--context", context, "--request-timeout=15s", "top", "nodes", "--no-headers"]),
        kubectl([
          "--context", context, "--request-timeout=15s", "top", "pods", "--no-headers",
          ...(namespace === ALL_NAMESPACES ? ["-A"] : ["-n", namespace]),
        ]).catch(() => ""),
      ]);
      const nodes = nodesOut
        .split("\n")
        .map((l) => l.trim().split(/\s+/))
        .filter((c) => c.length >= 4 && c[0])
        .map((c) => ({ name: c[0]!, cpu: parseCpu(c[1]), mem: parseMem(c[3]) }));
      const pods = podsOut
        .split("\n")
        .map((l) => l.trim().split(/\s+/))
        .filter((c) => c.length >= 3 && c[0])
        .map((c) =>
          namespace === ALL_NAMESPACES
            ? { namespace: c[0]!, name: c[1]!, cpu: parseCpu(c[2]), mem: parseMem(c[3]) }
            : { namespace, name: c[0]!, cpu: parseCpu(c[1]), mem: parseMem(c[2]) },
        );
      return { available: true, error: null, fetchedAt, nodes, pods };
    } catch (error) {
      return { available: false, error: (error as Error).message, fetchedAt, nodes: [], pods: [] };
    }
  }
  const metricsCache = cached(10_000, loadMetrics);

  // ---- storage (PVC/PV/StorageClass + kubelet volume stats) -------------------

  async function loadStorage(selection: Selection): Promise<Storage> {
    const { context, namespace } = selection;
    const errors: string[] = [];
    const safe = async <T>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await p;
      } catch (error) {
        errors.push(`${label}: ${(error as Error).message}`);
        return fallback;
      }
    };
    const [pvcs, pvs, scs, nodes] = await Promise.all([
      safe("persistentvolumeclaims", getJson(context, "persistentvolumeclaims", namespace), []),
      safe("persistentvolumes", getClusterJson(context, "persistentvolumes"), []),
      safe("storageclasses", getClusterJson(context, "storageclasses.storage.k8s.io"), []),
      safe("nodes", getClusterJson(context, "nodes"), []),
    ]);
    // Volume usage comes from each kubelet's /stats/summary (needs nodes/proxy).
    const usage = new Map<string, { used: number; available: number; inodesPct: number | null; node: string }>();
    const nodeDisks: Storage["nodeDisks"] = [];
    let usageAvailable = false;
    const nodeNames = nodes
      .map((n) => (n as { metadata?: { name?: string } }).metadata?.name)
      .filter((n): n is string => typeof n === "string");
    await mapLimit(nodeNames, 8, async (node) => {
      try {
        const out = await kubectl(
          ["--context", context, "get", "--raw", `/api/v1/nodes/${encodeURIComponent(node)}/proxy/stats/summary`],
          { timeoutMs: 15_000 },
        );
        usageAvailable = true;
        type Fs = { capacityBytes?: number; usedBytes?: number; availableBytes?: number; inodes?: number; inodesUsed?: number };
        const summary = JSON.parse(out) as {
          node?: { fs?: Fs; runtime?: { imageFs?: Fs } };
          pods?: {
            podRef?: { name: string; namespace: string };
            "ephemeral-storage"?: { usedBytes?: number };
            volume?: { pvcRef?: { name: string; namespace: string }; usedBytes?: number; availableBytes?: number; inodesUsed?: number; inodes?: number }[];
          }[];
        };
        const fs = summary.node?.fs;
        const imageFs = summary.node?.runtime?.imageFs;
        // Same capacity and free space = imagefs lives on the root disk.
        const imageFsSeparate =
          !!imageFs && !!fs && (imageFs.capacityBytes !== fs.capacityBytes || imageFs.availableBytes !== fs.availableBytes);
        nodeDisks.push({
          name: node,
          capacityBytes: fs?.capacityBytes ?? null,
          usedBytes: fs?.usedBytes ?? null,
          availableBytes: fs?.availableBytes ?? null,
          inodesUsedPct: fs?.inodes ? ((fs.inodesUsed ?? 0) / fs.inodes) * 100 : null,
          imagesBytes: imageFs?.usedBytes ?? null,
          imageFsSeparate,
          imageFsCapacityBytes: imageFsSeparate ? (imageFs?.capacityBytes ?? null) : null,
          topEphemeral: (summary.pods ?? [])
            .filter((p) => p.podRef && (p["ephemeral-storage"]?.usedBytes ?? 0) > 0)
            .map((p) => ({ namespace: p.podRef!.namespace, name: p.podRef!.name, usedBytes: p["ephemeral-storage"]!.usedBytes! }))
            .sort((a, b) => b.usedBytes - a.usedBytes)
            .slice(0, 5),
        });
        for (const pod of summary.pods ?? []) {
          for (const v of pod.volume ?? []) {
            if (!v.pvcRef || v.usedBytes === undefined) continue;
            usage.set(`${v.pvcRef.namespace}/${v.pvcRef.name}`, {
              used: v.usedBytes,
              available: v.availableBytes ?? 0,
              inodesPct: v.inodes ? ((v.inodesUsed ?? 0) / v.inodes) * 100 : null,
              node,
            });
          }
        }
      } catch (error) {
        if (errors.length < 10) errors.push(`stats ${node}: ${(error as Error).message}`);
      }
    });
    return {
      fetchedAt: new Date().toISOString(),
      nodeDisks: nodeDisks.sort((a, b) => a.name.localeCompare(b.name)),
      pvcs: pvcs.map((obj): Pvc => {
        const base = parsePvc(obj);
        const u = usage.get(`${base.namespace}/${base.name}`);
        return {
          ...base,
          usedBytes: u?.used ?? null,
          availableBytes: u?.available ?? null,
          inodesUsedPct: u?.inodesPct ?? null,
          node: u?.node ?? null,
        };
      }),
      pvs: pvs.map(parsePv),
      storageClasses: scs.map(parseStorageClass),
      usageAvailable,
      errors: [...new Set(errors)].slice(0, 10),
    };
  }
  const storageCache = cached(20_000, loadStorage);

  // ---- ArgoCD --------------------------------------------------------------

  async function loadArgo(selection: Selection): Promise<Argo> {
    const fetchedAt = new Date().toISOString();
    try {
      // Applications live in the ArgoCD namespace, not in the app's
      // destination namespace, so always list across namespaces.
      const items = await getJson(selection.context, "applications.argoproj.io", ALL_NAMESPACES);
      return { installed: true, error: null, fetchedAt, apps: items.map(parseArgoApp) };
    } catch (error) {
      const message = (error as Error).message;
      if (/doesn't have a resource type|the server doesn't have|no matches for kind/i.test(message)) {
        return { installed: false, error: null, fetchedAt, apps: [] };
      }
      return { installed: true, error: message, fetchedAt, apps: [] };
    }
  }
  const argoCache = cached(5_000, loadArgo);

  function invalidate(): void {
    snapshotCache.clear();
    metricsCache.clear();
    storageCache.clear();
    argoCache.clear();
    bb.realtime.publish(CHANGED, { at: Date.now() });
  }

  function assertWritable(): void {
    if (readOnly) throw new KubectlError("Read-only mode is on in the Kube plugin settings.");
  }

  // ---- mutations ---------------------------------------------------------

  async function restartPod(t: Target): Promise<string> {
    assertWritable();
    const out = await kubectl(["--context", t.context, "-n", t.namespace, "delete", "pod", t.name, "--wait=false"]);
    invalidate();
    bb.log.info(`deleted pod ${t.context}/${t.namespace}/${t.name}`);
    return out.trim() || `pod "${t.name}" deleted`;
  }

  async function rolloutRestart(t: Target & { kind: Workload["kind"] }): Promise<string> {
    assertWritable();
    const out = await kubectl([
      "--context", t.context, "-n", t.namespace, "rollout", "restart", `${t.kind.toLowerCase()}/${t.name}`,
    ]);
    invalidate();
    bb.log.info(`rollout restart ${t.kind} ${t.context}/${t.namespace}/${t.name}`);
    return out.trim();
  }

  async function scale(t: Target & { kind: "Deployment" | "StatefulSet"; replicas: number }): Promise<string> {
    assertWritable();
    const out = await kubectl([
      "--context", t.context, "-n", t.namespace,
      "scale", `${t.kind.toLowerCase()}/${t.name}`, `--replicas=${t.replicas}`,
    ]);
    invalidate();
    bb.log.info(`scaled ${t.kind} ${t.context}/${t.namespace}/${t.name} to ${t.replicas}`);
    return out.trim();
  }

  async function triggerCronJob(t: Target): Promise<string> {
    assertWritable();
    const suffix = Date.now().toString(36);
    const jobName = `${t.name.slice(0, 63 - suffix.length - 8)}-manual-${suffix}`;
    const out = await kubectl([
      "--context", t.context, "-n", t.namespace, "create", "job", jobName, `--from=cronjob/${t.name}`,
    ]);
    invalidate();
    return out.trim();
  }

  async function argoSync(t: Target & { prune: boolean }): Promise<string> {
    assertWritable();
    const raw = await kubectl([
      "--context", t.context, "-n", t.namespace, "get", "applications.argoproj.io", t.name, "-o", "json",
    ]);
    const app = parseArgoApp(JSON.parse(raw));
    if (app.operationPhase === "Running") {
      throw new KubectlError(`${t.name} already has a sync running.`);
    }
    // Same operation the argocd CLI/UI writes: the controller picks it up.
    const patch = {
      operation: {
        initiatedBy: { username: "bb-kube-plugin" },
        info: [{ name: "Reason", value: "Sync from bb" }],
        sync: {
          revision: app.targetRevision ?? "HEAD",
          prune: t.prune,
          syncStrategy: { hook: {} },
        },
      },
    };
    await kubectl([
      "--context", t.context, "-n", t.namespace,
      "patch", "applications.argoproj.io", t.name, "--type", "merge", "-p", JSON.stringify(patch),
    ]);
    invalidate();
    bb.log.info(`argocd sync ${t.context}/${t.namespace}/${t.name} prune=${t.prune}`);
    return `Sync of ${t.name} started${t.prune ? " (with prune)" : ""}`;
  }

  async function argoRefresh(t: Target & { hard: boolean }): Promise<string> {
    // Refresh only re-reads git and the cluster; allowed in read-only mode.
    await kubectl([
      "--context", t.context, "-n", t.namespace,
      "annotate", "applications.argoproj.io", t.name,
      `argocd.argoproj.io/refresh=${t.hard ? "hard" : "normal"}`, "--overwrite",
    ]);
    argoCache.clear();
    setTimeout(() => {
      argoCache.clear();
      bb.realtime.publish(CHANGED, { at: Date.now() });
    }, 3_000);
    return `${t.hard ? "Hard refresh" : "Refresh"} of ${t.name} requested`;
  }

  async function podLogs(t: Target & { container?: string; previous?: boolean; tail?: number }): Promise<string> {
    const args = [
      "--context", t.context, "-n", t.namespace,
      "logs", t.name, `--tail=${t.tail ?? 500}`, "--timestamps",
    ];
    if (t.container) args.push("-c", t.container);
    else args.push("--all-containers", "--prefix");
    if (t.previous) args.push("--previous");
    const out = await kubectl(args, { maxBuffer: 16 * 1024 * 1024 });
    return out.length > 2_000_000 ? out.slice(-2_000_000) : out;
  }

  async function workloadLogs(t: Target & { selector: string; tail?: number }): Promise<string> {
    const out = await kubectl(
      [
        "--context", t.context, "-n", t.namespace,
        "logs", "-l", t.selector, `--tail=${t.tail ?? 200}`,
        "--all-containers", "--prefix", "--timestamps", "--max-log-requests=20",
      ],
      { maxBuffer: 32 * 1024 * 1024, timeoutMs: 40_000 },
    );
    // Interleave by timestamp so the newest lines from every pod end last.
    const lines = out.split("\n").filter(Boolean);
    const stamp = (l: string) => /\] (\S+)/.exec(l)?.[1] ?? "";
    lines.sort((a, b) => stamp(a).localeCompare(stamp(b)));
    const text = lines.join("\n");
    return text.length > 2_000_000 ? text.slice(-2_000_000) : text;
  }

  async function describe(t: { context: string; namespace: string; name: string; kind: string }): Promise<string> {
    const clusterScoped = t.kind === "node" || t.kind === "persistentvolume";
    const scope = clusterScoped ? [] : ["-n", t.namespace];
    const out = await kubectl(["--context", t.context, ...scope, "describe", t.kind, t.name]);
    return out.length > 1_000_000 ? out.slice(0, 1_000_000) : out;
  }

  // ---- RPC ---------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    config: async () => {
      try {
        const { contexts, current } = await listContexts();
        const stored = await readSelection();
        const selection =
          stored && contexts.includes(stored.context)
            ? stored
            : current
              ? { context: current, namespace: ALL_NAMESPACES }
              : null;
        return {
          contexts,
          kubeconfigCurrent: current,
          selection,
          readOnly,
          refreshSeconds,
          language,
          error: contexts.length === 0 ? "No kubeconfig contexts found." : null,
        };
      } catch (error) {
        return {
          contexts: [],
          kubeconfigCurrent: null,
          selection: null,
          readOnly,
          refreshSeconds,
          language,
          error: (error as Error).message,
        };
      }
    },
    namespaces: async ({ context }) => {
      const out = await kubectl([
        "--context", context, "--request-timeout=15s",
        "get", "namespaces", "-o", "jsonpath={.items[*].metadata.name}",
      ]);
      return { namespaces: out.split(/\s+/).filter(Boolean).sort() };
    },
    select: async (selection) => {
      const { contexts } = await listContexts();
      if (!contexts.includes(selection.context)) throw new KubectlError(`Unknown context ${selection.context}`);
      if (selection.namespace !== ALL_NAMESPACES) nameSchema.parse(selection.namespace);
      await bb.storage.kv.set("selection", selection);
      invalidate();
      return selection;
    },
    snapshot: ({ force }) => snapshotCache.get(force === true),
    metrics: ({ force }) => metricsCache.get(force === true),
    storage: ({ force }) => storageCache.get(force === true),
    argocd: ({ force }) => argoCache.get(force === true),
    pod_logs: async (input) => ({ text: await podLogs(input) }),
    workload_logs: async (input) => ({ text: await workloadLogs(input) }),
    describe: async (input) => ({ text: await describe(input) }),
    pod_restart: async (input) => ({ message: await restartPod(input) }),
    rollout_restart: async (input) => ({ message: await rolloutRestart(input) }),
    scale: async (input) => ({ message: await scale(input) }),
    cronjob_trigger: async (input) => ({ message: await triggerCronJob(input) }),
    argocd_sync: async (input) => ({ message: await argoSync(input) }),
    argocd_refresh: async (input) => ({ message: await argoRefresh(input) }),
    rollout_status: async (input) => {
      const { contexts } = await listContexts();
      if (!contexts.includes(input.context)) {
        throw new KubectlError(`Unknown kubeconfig context "${input.context}". Known: ${contexts.join(", ")}`);
      }
      return rolloutStatus(kubectl, input);
    },
    contexts: async () => listContexts(),
    set_language: async ({ language: lang }) => {
      await settings.experimental_set({ language: lang });
      language = lang;
      bb.realtime.publish("kube-changed", { at: Date.now() });
      return { language };
    },
    pf_list: async () => ({ forwards: portForwards.list() }),
    pf_start: (input) => portForwards.start(input),
    pf_stop: async ({ id }) => {
      if (!portForwards.stop(id)) throw new KubectlError(`No port-forward ${id}`);
      return { message: `Stopped ${id}` };
    },
  });

  // ---- CLI for agents ----------------------------------------------------

  const usage = [
    "Usage:",
    "  bb kube status [--json]                    Health summary of the selected context/namespace",
    "  bb kube pods [--unhealthy] [--json]        List pods",
    "  bb kube workloads [--json]                 List deployments, statefulsets, daemonsets",
    "  bb kube events [--json]                    Recent warning events",
    "  bb kube nodes [--json]                     Node usage (metrics-server) and requests",
    "  bb kube pvc [--json]                       PVCs with fill level",
    "  bb kube argocd [--json]                    ArgoCD applications: sync and health",
    "  bb kube pf [--json]                        Active port-forwards",
    "  bb kube rollout <namespace> [kind/]<name>[,...] [--since=<ISO time>] [--context=<ctx>] [--json]",
    "                                             Rollout status: rolled out, which pods are new; prints a",
    "                                             ```kube-rollout block to paste into your reply",
    "  bb kube select <context> [namespace|*]     Change the selection shown in the sidebar",
    "  bb kube restart-pod <namespace> <pod>      Delete a pod so its controller recreates it",
    "  bb kube rollout-restart <namespace> <deployment|statefulset|daemonset>/<name>",
  ].join("\n");

  const MAX = 60_000;
  const clip = (text: string) => (text.length > MAX ? `${text.slice(0, MAX)}\n… (truncated)` : text);
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");
  const gib = (b: number | null) => (b === null ? "—" : `${(b / 1024 ** 3).toFixed(1)}Gi`);

  bb.cli.register({
    name: "kube",
    summary: "Inspect and control Kubernetes from bb",
    commands: [
      { name: "status", summary: "Cluster health summary", usage: "bb kube status [--json]" },
      { name: "pods", summary: "List pods", usage: "bb kube pods [--unhealthy] [--json]" },
      { name: "workloads", summary: "List workloads", usage: "bb kube workloads [--json]" },
      { name: "events", summary: "Recent warning events", usage: "bb kube events [--json]" },
      { name: "nodes", summary: "Node usage and requests", usage: "bb kube nodes [--json]" },
      { name: "pvc", summary: "PVCs with fill level", usage: "bb kube pvc [--json]" },
      { name: "argocd", summary: "ArgoCD applications", usage: "bb kube argocd [--json]" },
      { name: "pf", summary: "Active port-forwards", usage: "bb kube pf [--json]" },
      { name: "rollout", summary: "Rollout status of workloads + a kube-rollout block for chat", usage: "bb kube rollout <namespace> [kind/]<name>[,...] [--since=<ISO>] [--context=<ctx>] [--json]" },
      { name: "select", summary: "Select context/namespace", usage: "bb kube select <context> [namespace|*]" },
      { name: "restart-pod", summary: "Delete a pod (controller recreates it)", usage: "bb kube restart-pod <namespace> <pod>" },
      { name: "rollout-restart", summary: "Rollout-restart a workload", usage: "bb kube rollout-restart <namespace> <kind>/<name>" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const flags = new Set(argv.filter((a) => a.startsWith("--")));
      const flagValue = (name: string) =>
        argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
      const [command, ...args] = argv.filter((a) => !a.startsWith("--"));
      const out = (value: unknown, text: string) => {
        if (!json) return { exitCode: 0, stdout: clip(text) };
        const full = JSON.stringify(value);
        if (full.length <= MAX || !Array.isArray(value)) return { exitCode: 0, stdout: full.length <= MAX ? full : clip(full) };
        // Keep the output parseable: drop items from the end instead of cutting the string.
        let lo = 0;
        let hi = value.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (JSON.stringify(value.slice(0, mid)).length <= MAX) lo = mid;
          else hi = mid - 1;
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify(value.slice(0, lo)),
          stderr: `Output truncated to ${lo} of ${value.length} items; narrow it with "bb kube select <context> <namespace>" or --unhealthy.`,
        };
      };
      try {
        switch (command) {
          case undefined:
          case "help":
            return { exitCode: 0, stdout: usage };
          case "status": {
            const s = await snapshotCache.get();
            const badPods = s.pods.filter((p) => !p.healthy);
            const badWl = s.workloads.filter((w) => !w.healthy);
            const warnings = s.events.filter((e) => e.type === "Warning");
            const summary = {
              selection: s.selection,
              pods: { total: s.pods.length, unhealthy: badPods.length },
              workloads: { total: s.workloads.length, unhealthy: badWl.length },
              nodes: { total: s.nodes.length, notReady: s.nodes.filter((n) => !n.ready).length },
              warningEvents: warnings.length,
              unhealthyPods: badPods.map((p) => `${p.namespace}/${p.name} ${p.status} restarts=${p.restarts}`),
              unhealthyWorkloads: badWl.map((w) => `${w.kind} ${w.namespace}/${w.name} ${w.ready}/${w.desired}`),
              errors: s.errors,
            };
            const text = [
              `Context ${s.selection.context}, namespace ${s.selection.namespace === "*" ? "all" : s.selection.namespace}`,
              `Pods: ${s.pods.length} (${badPods.length} unhealthy)`,
              `Workloads: ${s.workloads.length} (${badWl.length} unhealthy)`,
              `Nodes: ${s.nodes.length} (${summary.nodes.notReady} not ready)`,
              `Warning events: ${warnings.length}`,
              ...summary.unhealthyPods.map((l) => `  pod ${l}`),
              ...summary.unhealthyWorkloads.map((l) => `  ${l}`),
              ...s.errors.map((e) => `  error: ${e}`),
            ].join("\n");
            return out(summary, text);
          }
          case "pods": {
            const s = await snapshotCache.get();
            const pods = flags.has("--unhealthy") ? s.pods.filter((p) => !p.healthy) : s.pods;
            return out(pods, pods.map((p) => `${p.namespace}\t${p.name}\t${p.ready}\t${p.status}\t${p.restarts}`).join("\n") || "No pods.");
          }
          case "workloads": {
            const s = await snapshotCache.get();
            return out(s.workloads, s.workloads.map((w) => `${w.kind}\t${w.namespace}\t${w.name}\t${w.ready}/${w.desired}`).join("\n") || "No workloads.");
          }
          case "events": {
            const s = await snapshotCache.get();
            const ev = s.events.filter((e) => e.type === "Warning").slice(0, 50);
            return out(ev, ev.map((e) => `${e.lastSeen ?? ""}\t${e.namespace}\t${e.object}\t${e.reason}\t${e.message}`).join("\n") || "No warning events.");
          }
          case "nodes": {
            const [s, m, st] = await Promise.all([snapshotCache.get(), metricsCache.get(), storageCache.get()]);
            const rows = s.nodes.map((n) => {
              const usage = m.nodes.find((x) => x.name === n.name);
              const pods = s.pods.filter((p) => p.node === n.name && !p.terminated);
              const cpuReq = pods.reduce((a, p) => a + p.cpuRequest, 0);
              const memReq = pods.reduce((a, p) => a + p.memRequest, 0);
              return {
                name: n.name, ready: n.ready, pool: n.pool, instanceType: n.instanceType,
                cpuUsed: usage?.cpu ?? null, cpuRequested: cpuReq, cpuAllocatable: n.cpuAllocatable,
                memUsed: usage?.mem ?? null, memRequested: memReq, memAllocatable: n.memAllocatable,
                pods: pods.length, podCapacity: n.podCapacity,
                disk: st.nodeDisks.find((d) => d.name === n.name) ?? null,
              };
            });
            const text = [
              "NODE\tREADY\tCPU used/req\tMEM used/req\tDISK\tPODS",
              ...rows.map((r) =>
                `${r.name}\t${r.ready ? "yes" : "NO"}\t${r.cpuUsed === null ? "—" : pct(r.cpuUsed, r.cpuAllocatable)}/${pct(r.cpuRequested, r.cpuAllocatable)}\t${r.memUsed === null ? "—" : pct(r.memUsed, r.memAllocatable)}/${pct(r.memRequested, r.memAllocatable)}\t${r.disk?.capacityBytes ? `${pct(r.disk.usedBytes ?? 0, r.disk.capacityBytes)} of ${gib(r.disk.capacityBytes)}` : "—"}\t${r.pods}/${r.podCapacity}`,
              ),
              ...(m.available ? [] : [`(metrics-server unavailable: ${m.error})`]),
            ].join("\n");
            return out(rows, text);
          }
          case "pvc": {
            const st = await storageCache.get();
            const rows = st.pvcs.map((p) => ({
              ...p,
              usedPct: p.usedBytes !== null && p.capacityBytes ? (p.usedBytes / p.capacityBytes) * 100 : null,
            }));
            rows.sort((a, b) => (b.usedPct ?? -1) - (a.usedPct ?? -1));
            return out(rows, rows.map((p) => `${p.namespace}/${p.name}\t${p.status}\t${gib(p.usedBytes)}/${gib(p.capacityBytes)}\t${p.usedPct === null ? "—" : `${p.usedPct.toFixed(0)}%`}\t${p.storageClass ?? ""}`).join("\n") || "No PVCs.");
          }
          case "argocd": {
            const a = await argoCache.get();
            if (!a.installed) return out(a, "ArgoCD is not installed in this cluster.");
            return out(a.apps, a.apps.map((x) => `${x.name}\t${x.sync}\t${x.health}\t${x.operationPhase ?? ""}\t${x.targetRevision ?? ""}`).join("\n") || a.error || "No applications.");
          }
          case "pf": {
            const list = portForwards.list();
            return out(list, list.map((f) => `${f.id}\t${f.status}\t127.0.0.1:${f.localPort ?? "?"} -> ${f.namespace}/${f.kind}/${f.name}:${f.remotePort}`).join("\n") || "No port-forwards.");
          }
          case "rollout": {
            const [namespace, list = ""] = args;
            if (!namespace) break;
            const context = flagValue("context") ?? (await effectiveSelection()).context;
            const since = flagValue("since");
            const kinds: Record<string, "Deployment" | "StatefulSet" | "DaemonSet"> = {
              deployment: "Deployment", deploy: "Deployment", statefulset: "StatefulSet", sts: "StatefulSet", daemonset: "DaemonSet", ds: "DaemonSet",
            };
            const workloads = list
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
              .map((ref) => {
                const [k, n] = ref.includes("/") ? ref.split("/") : ["deployment", ref];
                const kind = kinds[(k ?? "").toLowerCase()];
                if (!kind || !n) throw new KubectlError(`Bad workload "${ref}". Use name or deployment/name, sts/name, ds/name.`);
                return { kind, name: n };
              });
            const { contexts } = await listContexts();
            if (!contexts.includes(context)) return { exitCode: 1, stderr: `Unknown context. Known: ${contexts.join(", ")}` };
            const status = await rolloutStatus(kubectl, rolloutInputSchema.parse({ context, namespace, workloads, ...(since ? { since } : {}) }));
            const icon = (w: (typeof status.workloads)[number]) =>
              w.state === "failed" || w.state === "missing" ? "✗" : w.restarted === "yes" || (w.restarted === null && w.state === "complete") ? "✓" : "…";
            const block = [
              "```kube-rollout",
              `context: ${context}`,
              `namespace: ${namespace}`,
              ...(status.since ? [`since: ${status.since}`] : []),
              ...(workloads.length ? [`workloads: ${workloads.map((w) => `${w.kind.toLowerCase()}/${w.name}`).join(", ")}`] : []),
              "```",
            ].join("\n");
            const text = [
              ...status.workloads.map((w) => {
                const fresh = w.pods.filter((p) => p.fresh && p.current).length;
                return `${icon(w)} ${w.kind} ${w.name}: ${w.state}${w.restarted ? `, restarted ${w.restarted} (${fresh}/${w.pods.length} pods new)` : ""}, ready ${w.ready}/${w.desired}, rev ${w.revision ?? "?"}${w.message ? ` — ${w.message}` : ""}`;
              }),
              "",
              "Paste this block into your reply to show live status in the chat:",
              block,
            ].join("\n");
            return out({ ...status, block }, text);
          }
          case "select": {
            const [context, namespace = ALL_NAMESPACES] = args;
            if (!context) break;
            const { contexts } = await listContexts();
            if (!contexts.includes(context)) return { exitCode: 1, stderr: `Unknown context. Known: ${contexts.join(", ")}` };
            const selection = { context, namespace };
            await bb.storage.kv.set("selection", selection);
            invalidate();
            return out(selection, `Selected ${context} / ${namespace === "*" ? "all namespaces" : namespace}`);
          }
          case "restart-pod": {
            const [namespace, name] = args;
            if (!namespace || !name) break;
            const { context } = await effectiveSelection();
            const msg = await restartPod(targetSchema.parse({ context, namespace, name }));
            return out({ message: msg }, msg);
          }
          case "rollout-restart": {
            const [namespace, ref] = args;
            const [kindRaw, name] = (ref ?? "").split("/");
            const kinds = { deployment: "Deployment", statefulset: "StatefulSet", daemonset: "DaemonSet" } as const;
            const kind = kinds[(kindRaw ?? "").toLowerCase() as keyof typeof kinds];
            if (!namespace || !name || !kind) break;
            const { context } = await effectiveSelection();
            const msg = await rolloutRestart({ ...targetSchema.parse({ context, namespace, name }), kind });
            return out({ message: msg }, msg);
          }
        }
        return { exitCode: 1, stderr: usage };
      } catch (error) {
        return { exitCode: 1, stderr: (error as Error).message };
      }
    },
  });

  bb.log.info(`loaded (kubectl: ${kubectlBin}, readOnly: ${readOnly})`);
}
