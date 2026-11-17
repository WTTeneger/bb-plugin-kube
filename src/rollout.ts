// Rollout status for a set of workloads: is each one rolled out, and which of
// its pods are new (current revision, started after `since`) or still old.
// Backs the ```kube-rollout block that agents put in chat messages.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RolloutInput, RolloutPod, RolloutStatus, RolloutWorkload } from "./contract";
import { parsePod, parseWorkload } from "./parse";

type Kubectl = (args: string[], options?: { timeoutMs?: number }) => Promise<string>;

function items(raw: string): any[] {
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed.items)) return parsed.items;
  return parsed.kind ? [parsed] : [];
}

function matches(selector: any, labels: Record<string, string>): boolean {
  const ml: Record<string, string> = selector?.matchLabels ?? {};
  for (const [k, v] of Object.entries(ml)) if (labels[k] !== v) return false;
  for (const e of selector?.matchExpressions ?? []) {
    const val = labels[e.key];
    const values: string[] = e.values ?? [];
    if (e.operator === "In" && !values.includes(val ?? "")) return false;
    if (e.operator === "NotIn" && val !== undefined && values.includes(val)) return false;
    if (e.operator === "Exists" && val === undefined) return false;
    if (e.operator === "DoesNotExist" && val !== undefined) return false;
  }
  return Object.keys(ml).length > 0 || (selector?.matchExpressions?.length ?? 0) > 0;
}

export async function rolloutStatus(kubectl: Kubectl, input: RolloutInput): Promise<RolloutStatus> {
  const { context, namespace } = input;
  const sinceMs = input.since ? Date.parse(input.since) : NaN;
  const since = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null;
  const base = ["--context", context, "-n", namespace, "--request-timeout=20s"];

  // No list given: every workload in the namespace (analysis mode).
  const wanted = input.workloads;
  const byKind = new Map<string, string[]>();
  for (const w of wanted) byKind.set(w.kind, [...(byKind.get(w.kind) ?? []), w.name]);
  const kinds = wanted.length ? [...byKind.keys()] : ["Deployment", "StatefulSet", "DaemonSet"];

  const resource = (kind: string) => `${kind.toLowerCase()}s.apps`;
  const [objLists, podsRaw, rsRaw] = await Promise.all([
    Promise.all(
      kinds.map((kind) =>
        kubectl([...base, "get", resource(kind), ...(byKind.get(kind) ?? []), "--ignore-not-found", "-o", "json"]).then(items),
      ),
    ),
    kubectl([...base, "get", "pods", "-o", "json"]).then(items),
    byKind.has("Deployment") || !wanted.length
      ? kubectl([...base, "get", "replicasets.apps", "-o", "json"]).then(items)
      : Promise.resolve([] as any[]),
  ]);
  const objects = objLists.flat();

  const workloads: RolloutWorkload[] = [];
  const seen = new Set<string>();
  for (const obj of objects) {
    const kind = obj.kind as RolloutWorkload["kind"];
    const name = String(obj.metadata?.name);
    seen.add(`${kind}/${name}`);
    const st = obj.status ?? {};
    const spec = obj.spec ?? {};
    const tmplAnn = spec.template?.metadata?.annotations ?? {};
    const images: string[] = (spec.template?.spec?.containers ?? []).map((c: any) => String(c.image ?? ""));

    // Which pods belong to it, and which label marks the current revision.
    const owned = podsRaw.filter((p) => matches(spec.selector, p.metadata?.labels ?? {}));
    let isCurrent: (pod: any) => boolean = () => true;
    let revision: string | null = null;
    let desired = 0;
    let ready = 0;
    let updated = 0;
    let available = 0;
    let state: RolloutWorkload["state"] = "progressing";
    let message: string | null = null;

    if (kind === "Deployment") {
      desired = Number(spec.replicas ?? 1);
      ready = Number(st.readyReplicas ?? 0);
      updated = Number(st.updatedReplicas ?? 0);
      available = Number(st.availableReplicas ?? 0);
      revision = obj.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? null;
      const rs = rsRaw.find(
        (r) =>
          r.metadata?.ownerReferences?.some((o: any) => o.kind === "Deployment" && o.name === name) &&
          r.metadata?.annotations?.["deployment.kubernetes.io/revision"] === revision,
      );
      const hash = rs?.metadata?.labels?.["pod-template-hash"];
      if (hash) isCurrent = (p) => p.metadata?.labels?.["pod-template-hash"] === hash;
      const progressing = (st.conditions ?? []).find((c: any) => c.type === "Progressing");
      const total = Number(st.replicas ?? 0);
      if (progressing?.reason === "ProgressDeadlineExceeded") {
        state = "failed";
        message = progressing.message ?? "progress deadline exceeded";
      } else if (
        Number(st.observedGeneration ?? 0) >= Number(obj.metadata?.generation ?? 0) &&
        updated >= desired &&
        available >= desired &&
        total <= desired
      ) {
        state = "complete";
      }
    } else if (kind === "StatefulSet") {
      desired = Number(spec.replicas ?? 1);
      ready = Number(st.readyReplicas ?? 0);
      updated = Number(st.updatedReplicas ?? 0);
      available = Number(st.availableReplicas ?? ready);
      revision = st.updateRevision ?? null;
      if (revision) isCurrent = (p) => p.metadata?.labels?.["controller-revision-hash"] === revision;
      if (
        Number(st.observedGeneration ?? 0) >= Number(obj.metadata?.generation ?? 0) &&
        (!st.updateRevision || st.updateRevision === st.currentRevision) &&
        ready >= desired &&
        updated >= desired
      ) {
        state = "complete";
      }
    } else {
      desired = Number(st.desiredNumberScheduled ?? 0);
      ready = Number(st.numberReady ?? 0);
      updated = Number(st.updatedNumberScheduled ?? 0);
      available = Number(st.numberAvailable ?? 0);
      const gen = String(obj.metadata?.generation ?? "");
      revision = gen || null;
      isCurrent = (p) => p.metadata?.labels?.["pod-template-generation"] === gen;
      if (
        Number(st.observedGeneration ?? 0) >= Number(obj.metadata?.generation ?? 0) &&
        updated >= desired &&
        available >= desired
      ) {
        state = "complete";
      }
    }
    if (desired === 0 && state !== "failed") state = "scaled-to-zero";

    const pods = owned
      .map((raw): RolloutPod => {
        const p = parsePod(raw);
        const created = Date.parse(p.createdAt);
        return {
          name: p.name,
          status: p.status,
          ready: p.ready,
          healthy: p.healthy,
          restarts: p.restarts,
          lastRestartAt: p.lastRestartAt,
          createdAt: p.createdAt,
          node: p.node,
          image: p.containers[0]?.image ?? null,
          current: isCurrent(raw),
          fresh: since ? created >= Date.parse(since) : null,
        };
      })
      .sort((a, b) => Number(b.current) - Number(a.current) || b.createdAt.localeCompare(a.createdAt));

    let restarted: RolloutWorkload["restarted"] = null;
    if (since) {
      const live = pods.filter((p) => p.status !== "Terminating" && p.status !== "Succeeded");
      const freshCount = live.filter((p) => p.fresh && p.current).length;
      restarted =
        live.length > 0 && freshCount === live.length && state === "complete"
          ? "yes"
          : freshCount > 0
            ? "partial"
            : "no";
    }

    workloads.push({
      kind,
      name,
      found: true,
      desired,
      ready,
      updated,
      available,
      revision,
      images,
      restartedAt: tmplAnn["kubectl.kubernetes.io/restartedAt"] ?? null,
      state,
      selector: parseWorkload(obj).selector,
      restarted,
      message,
      pods: pods.slice(0, 50),
    });
  }

  for (const w of wanted) {
    if (seen.has(`${w.kind}/${w.name}`)) continue;
    workloads.push({
      kind: w.kind,
      name: w.name,
      found: false,
      desired: 0,
      ready: 0,
      updated: 0,
      available: 0,
      revision: null,
      images: [],
      restartedAt: null,
      state: "missing",
      selector: null,
      restarted: since ? "no" : null,
      message: `${w.kind} ${w.name} not found in ${namespace}`,
      pods: [],
    });
  }

  // Keep the order the agent listed; in analysis mode show problems first.
  if (wanted.length) {
    const order = new Map(wanted.map((w, i) => [`${w.kind}/${w.name}`, i]));
    workloads.sort((a, b) => (order.get(`${a.kind}/${a.name}`) ?? 0) - (order.get(`${b.kind}/${b.name}`) ?? 0));
  } else {
    const rank = { failed: 0, missing: 1, progressing: 2, complete: 3, "scaled-to-zero": 4 } as const;
    workloads.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
  }

  return {
    context,
    namespace,
    since,
    fetchedAt: new Date().toISOString(),
    workloads: workloads.slice(0, 60),
    error: null,
  };
}
