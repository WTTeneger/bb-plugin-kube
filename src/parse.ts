// kubectl JSON → compact wire types.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  ArgoApp,
  Ingress,
  Job,
  KubeEvent,
  KubeNode,
  Pod,
  Pv,
  Pvc,
  Service,
  StorageClass,
  Workload,
  WorkloadRef,
} from "./contract";

type K = any;

// ---- quantities --------------------------------------------------------------

/** "250m" → 250, "2" → 2000, "1.5" → 1500, "100n" → 0.0001. Millicores. */
export function parseCpu(q: unknown): number {
  if (q === undefined || q === null || q === "") return 0;
  const s = String(q).trim();
  const m = /^([0-9.]+)([numk]?)$/.exec(s);
  if (!m) return 0;
  const v = Number(m[1]);
  switch (m[2]) {
    case "n":
      return v / 1e6;
    case "u":
      return v / 1e3;
    case "m":
      return v;
    case "k":
      return v * 1e6;
    default:
      return v * 1000;
  }
}

const MEM_UNITS: Record<string, number> = {
  "": 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  m: 1e-3,
};

/** "512Mi" → bytes. Also handles "1e9" and plain numbers. */
export function parseMem(q: unknown): number {
  if (q === undefined || q === null || q === "") return 0;
  const s = String(q).trim();
  const m = /^([0-9.]+(?:e[0-9]+)?)([a-zA-Z]*)$/.exec(s);
  if (!m) return 0;
  const mult = MEM_UNITS[m[2] ?? ""];
  return mult === undefined ? 0 : Number(m[1]) * mult;
}

const ts = (v: unknown) => (typeof v === "string" ? v : "");

// ---- pods ---------------------------------------------------------------------

function podStatus(pod: K): string {
  if (pod.metadata?.deletionTimestamp) return "Terminating";
  const statuses: K[] = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  for (const cs of statuses) {
    const waiting = cs.state?.waiting?.reason;
    if (waiting && waiting !== "PodInitializing") return waiting;
    const terminated = cs.state?.terminated?.reason;
    if (terminated && terminated !== "Completed" && pod.status?.phase !== "Succeeded")
      return terminated;
  }
  return pod.status?.reason ?? pod.status?.phase ?? "Unknown";
}

/** ReplicaSet "api-7d58f4599b" + template hash "7d58f4599b" → Deployment "api". */
function resolveWorkload(pod: K): WorkloadRef | null {
  const owner = pod.metadata?.ownerReferences?.find((o: K) => o.controller) ??
    pod.metadata?.ownerReferences?.[0];
  if (!owner) return null;
  if (owner.kind === "ReplicaSet") {
    const hash = pod.metadata?.labels?.["pod-template-hash"];
    const name = String(owner.name);
    if (hash && name.endsWith(`-${hash}`)) {
      return { kind: "Deployment", name: name.slice(0, -(hash.length + 1)) };
    }
    return { kind: "ReplicaSet", name };
  }
  return { kind: String(owner.kind), name: String(owner.name) };
}

export function parsePod(pod: K): Pod {
  const statuses: K[] = pod.status?.containerStatuses ?? [];
  const specContainers: K[] = pod.spec?.containers ?? [];
  const containers = specContainers.map((container) => {
    const cs = statuses.find((s) => s.name === container.name);
    const stateKey = cs?.state ? Object.keys(cs.state)[0] ?? "unknown" : "pending";
    return {
      name: String(container.name),
      image: String(container.image ?? ""),
      ready: cs?.ready === true,
      restarts: Number(cs?.restartCount ?? 0),
      state: stateKey,
      reason:
        cs?.state?.waiting?.reason ??
        cs?.state?.terminated?.reason ??
        cs?.lastState?.terminated?.reason ??
        null,
      ports: (container.ports ?? []).map((p: K) => ({
        name: p.name ?? null,
        port: Number(p.containerPort),
        protocol: String(p.protocol ?? "TCP"),
      })),
    };
  });
  let cpuRequest = 0;
  let cpuLimit = 0;
  let memRequest = 0;
  let memLimit = 0;
  for (const c of specContainers) {
    cpuRequest += parseCpu(c.resources?.requests?.cpu);
    cpuLimit += parseCpu(c.resources?.limits?.cpu);
    memRequest += parseMem(c.resources?.requests?.memory);
    memLimit += parseMem(c.resources?.limits?.memory);
  }
  const restarts = containers.reduce((sum, c) => sum + c.restarts, 0);
  const lastRestartAt =
    statuses
      .map((s) => s.lastState?.terminated?.finishedAt as string | undefined)
      .filter((v): v is string => typeof v === "string")
      .sort()
      .at(-1) ?? null;
  const readyCount = containers.filter((c) => c.ready).length;
  const status = podStatus(pod);
  const phase = String(pod.status?.phase ?? "Unknown");
  const owner = pod.metadata?.ownerReferences?.[0];
  const healthy =
    phase === "Succeeded" ||
    (phase === "Running" && readyCount === containers.length && status === "Running");
  return {
    namespace: String(pod.metadata?.namespace ?? ""),
    name: String(pod.metadata?.name ?? ""),
    phase,
    status,
    ready: `${readyCount}/${containers.length}`,
    restarts,
    lastRestartAt,
    node: pod.spec?.nodeName ?? null,
    ip: pod.status?.podIP ?? null,
    createdAt: ts(pod.metadata?.creationTimestamp),
    owner: owner ? `${owner.kind}/${owner.name}` : null,
    workload: resolveWorkload(pod),
    healthy,
    terminated: phase === "Succeeded" || phase === "Failed",
    containers,
    pvcs: (pod.spec?.volumes ?? [])
      .map((v: K) => v.persistentVolumeClaim?.claimName)
      .filter((n: unknown): n is string => typeof n === "string"),
    cpuRequest,
    cpuLimit,
    memRequest,
    memLimit,
  };
}

// ---- workloads ------------------------------------------------------------------

function selectorString(sel: K): string | null {
  if (!sel) return null;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(sel.matchLabels ?? {})) parts.push(`${k}=${v}`);
  for (const e of sel.matchExpressions ?? []) {
    const values = (e.values ?? []).join(",");
    if (e.operator === "In") parts.push(`${e.key} in (${values})`);
    else if (e.operator === "NotIn") parts.push(`${e.key} notin (${values})`);
    else if (e.operator === "Exists") parts.push(String(e.key));
    else if (e.operator === "DoesNotExist") parts.push(`!${e.key}`);
  }
  return parts.length ? parts.join(",") : null;
}

export function parseWorkload(obj: K): Workload {
  const kind = obj.kind as Workload["kind"];
  const status = obj.status ?? {};
  let desired: number;
  let ready: number;
  let updated: number;
  let available: number;
  if (kind === "DaemonSet") {
    desired = Number(status.desiredNumberScheduled ?? 0);
    ready = Number(status.numberReady ?? 0);
    updated = Number(status.updatedNumberScheduled ?? 0);
    available = Number(status.numberAvailable ?? 0);
  } else {
    desired = Number(obj.spec?.replicas ?? 1);
    ready = Number(status.readyReplicas ?? 0);
    updated = Number(status.updatedReplicas ?? 0);
    available = Number(status.availableReplicas ?? 0);
  }
  const conditions: K[] = status.conditions ?? [];
  const failing = conditions.find(
    (c) =>
      (c.type === "Available" && c.status === "False") ||
      (c.type === "Progressing" && c.status === "False") ||
      c.type === "ReplicaFailure",
  );
  const images = (obj.spec?.template?.spec?.containers ?? []).map((c: K) =>
    String(c.image ?? ""),
  );
  return {
    kind,
    namespace: String(obj.metadata?.namespace ?? ""),
    name: String(obj.metadata?.name ?? ""),
    desired,
    ready,
    updated,
    available,
    images,
    createdAt: ts(obj.metadata?.creationTimestamp),
    healthy: ready >= desired && failing === undefined,
    progressing: updated < desired,
    message: failing?.message ?? null,
    selector: selectorString(obj.spec?.selector),
    revision:
      kind === "Deployment"
        ? (obj.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? null)
        : kind === "StatefulSet"
          ? (status.updateRevision ? String(status.updateRevision).split("-").at(-1)! : null)
          : obj.metadata?.generation !== undefined
            ? String(obj.metadata.generation)
            : null,
    // Progressing.lastUpdateTime moves on every rollout step, so its latest
    // value is when the current revision finished (or last progressed).
    updatedAt: conditions.find((c) => c.type === "Progressing")?.lastUpdateTime ?? null,
  };
}

export function parseJob(obj: K): Job {
  if (obj.kind === "CronJob") {
    const suspended = obj.spec?.suspend === true;
    return {
      kind: "CronJob",
      namespace: String(obj.metadata?.namespace ?? ""),
      name: String(obj.metadata?.name ?? ""),
      status: suspended ? "Suspended" : `${(obj.status?.active ?? []).length} active`,
      schedule: obj.spec?.schedule ?? null,
      lastRunAt: obj.status?.lastScheduleTime ?? null,
      suspended,
      healthy: true,
      createdAt: ts(obj.metadata?.creationTimestamp),
    };
  }
  const st = obj.status ?? {};
  const failedCond = (st.conditions ?? []).find(
    (c: K) => c.type === "Failed" && c.status === "True",
  );
  const completions = Number(obj.spec?.completions ?? 1);
  const status = failedCond
    ? "Failed"
    : Number(st.succeeded ?? 0) >= completions
      ? "Complete"
      : Number(st.active ?? 0) > 0
        ? "Running"
        : "Pending";
  return {
    kind: "Job",
    namespace: String(obj.metadata?.namespace ?? ""),
    name: String(obj.metadata?.name ?? ""),
    status,
    schedule: null,
    lastRunAt: st.startTime ?? null,
    suspended: obj.spec?.suspend === true,
    healthy: !failedCond,
    createdAt: ts(obj.metadata?.creationTimestamp),
  };
}

export function parseService(obj: K): Service {
  const lb = obj.status?.loadBalancer?.ingress?.[0];
  return {
    namespace: String(obj.metadata?.namespace ?? ""),
    name: String(obj.metadata?.name ?? ""),
    type: String(obj.spec?.type ?? "ClusterIP"),
    clusterIP: obj.spec?.clusterIP ?? null,
    externalIP: lb?.ip ?? lb?.hostname ?? obj.spec?.externalIPs?.[0] ?? null,
    ports: (obj.spec?.ports ?? []).map((p: K) => ({
      name: p.name ?? null,
      port: Number(p.port),
      targetPort: p.targetPort === undefined ? null : String(p.targetPort),
      nodePort: p.nodePort ? Number(p.nodePort) : null,
      protocol: String(p.protocol ?? "TCP"),
    })),
    createdAt: ts(obj.metadata?.creationTimestamp),
  };
}

export function parseIngress(obj: K): Ingress {
  const lb = obj.status?.loadBalancer?.ingress?.[0];
  return {
    namespace: String(obj.metadata?.namespace ?? ""),
    name: String(obj.metadata?.name ?? ""),
    className: obj.spec?.ingressClassName ?? null,
    hosts: (obj.spec?.rules ?? [])
      .map((r: K) => r.host)
      .filter((h: unknown): h is string => typeof h === "string"),
    address: lb?.ip ?? lb?.hostname ?? null,
    createdAt: ts(obj.metadata?.creationTimestamp),
  };
}

export function parseNode(obj: K, podCount: number): KubeNode {
  const conditions: K[] = obj.status?.conditions ?? [];
  const labels: Record<string, string> = obj.metadata?.labels ?? {};
  const ready = conditions.some((c) => c.type === "Ready" && c.status === "True");
  // Only the standard problem conditions: providers add their own types
  // (e.g. DigitalOcean's CiliumAgentReady) where True is the healthy value.
  const PROBLEMS = new Set(["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"]);
  const pressure = conditions
    .filter((c) => PROBLEMS.has(String(c.type)) && c.status === "True")
    .map((c) => String(c.type));
  const roles =
    Object.keys(labels)
      .filter((l) => l.startsWith("node-role.kubernetes.io/"))
      .map((l) => l.slice("node-role.kubernetes.io/".length))
      .join(",") || "worker";
  const info = obj.status?.nodeInfo ?? {};
  return {
    name: String(obj.metadata?.name ?? ""),
    ready,
    roles,
    version: String(info.kubeletVersion ?? ""),
    cpuAllocatable: parseCpu(obj.status?.allocatable?.cpu),
    memAllocatable: parseMem(obj.status?.allocatable?.memory),
    podCapacity: Number(obj.status?.allocatable?.pods ?? 0),
    pods: podCount,
    unschedulable: obj.spec?.unschedulable === true,
    pressure,
    taints: (obj.spec?.taints ?? []).map(
      (t: K) => `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`,
    ),
    instanceType:
      labels["node.kubernetes.io/instance-type"] ?? labels["beta.kubernetes.io/instance-type"] ?? null,
    zone: labels["topology.kubernetes.io/zone"] ?? labels["topology.kubernetes.io/region"] ?? null,
    pool:
      labels["doks.digitalocean.com/node-pool"] ??
      labels["cloud.google.com/gke-nodepool"] ??
      labels["eks.amazonaws.com/nodegroup"] ??
      labels["kubernetes.azure.com/agentpool"] ??
      labels["karpenter.sh/nodepool"] ??
      null,
    internalIP:
      (obj.status?.addresses ?? []).find((a: K) => a.type === "InternalIP")?.address ?? null,
    osImage: String(info.osImage ?? ""),
    kernel: String(info.kernelVersion ?? ""),
    runtime: String(info.containerRuntimeVersion ?? ""),
    createdAt: ts(obj.metadata?.creationTimestamp),
  };
}

export function parseEvent(obj: K): KubeEvent {
  const involved = obj.involvedObject ?? obj.regarding ?? {};
  return {
    namespace: String(obj.metadata?.namespace ?? ""),
    type: String(obj.type ?? "Normal"),
    reason: String(obj.reason ?? ""),
    object: `${involved.kind ?? "?"}/${involved.name ?? "?"}`,
    message: String(obj.message ?? obj.note ?? "").slice(0, 500),
    count: Number(obj.count ?? obj.series?.count ?? 1),
    lastSeen: obj.lastTimestamp ?? obj.eventTime ?? obj.metadata?.creationTimestamp ?? null,
  };
}

// ---- storage ------------------------------------------------------------------

export function parsePvc(obj: K): Omit<Pvc, "usedBytes" | "availableBytes" | "inodesUsedPct" | "node"> {
  const conditions: K[] = obj.status?.conditions ?? [];
  return {
    namespace: String(obj.metadata?.namespace ?? ""),
    name: String(obj.metadata?.name ?? ""),
    status: String(obj.status?.phase ?? "Unknown"),
    capacityBytes: obj.status?.capacity?.storage ? parseMem(obj.status.capacity.storage) : null,
    requestBytes: obj.spec?.resources?.requests?.storage
      ? parseMem(obj.spec.resources.requests.storage)
      : null,
    storageClass: obj.spec?.storageClassName ?? null,
    accessModes: (obj.status?.accessModes ?? obj.spec?.accessModes ?? []).map(String),
    volume: obj.spec?.volumeName ?? null,
    volumeMode: obj.spec?.volumeMode ?? null,
    createdAt: ts(obj.metadata?.creationTimestamp),
    resizing: conditions.some(
      (c) => (c.type === "Resizing" || c.type === "FileSystemResizePending") && c.status === "True",
    ),
  };
}

export function parsePv(obj: K): Pv {
  const claim = obj.spec?.claimRef;
  return {
    name: String(obj.metadata?.name ?? ""),
    status: String(obj.status?.phase ?? "Unknown"),
    capacityBytes: obj.spec?.capacity?.storage ? parseMem(obj.spec.capacity.storage) : null,
    claim: claim ? `${claim.namespace}/${claim.name}` : null,
    storageClass: obj.spec?.storageClassName ?? null,
    reclaimPolicy: obj.spec?.persistentVolumeReclaimPolicy ?? null,
    createdAt: ts(obj.metadata?.creationTimestamp),
  };
}

export function parseStorageClass(obj: K): StorageClass {
  const ann = obj.metadata?.annotations ?? {};
  return {
    name: String(obj.metadata?.name ?? ""),
    provisioner: String(obj.provisioner ?? ""),
    isDefault:
      ann["storageclass.kubernetes.io/is-default-class"] === "true" ||
      ann["storageclass.beta.kubernetes.io/is-default-class"] === "true",
    reclaimPolicy: obj.reclaimPolicy ?? null,
    allowExpansion: obj.allowVolumeExpansion === true,
    bindingMode: obj.volumeBindingMode ?? null,
  };
}

// ---- ArgoCD -------------------------------------------------------------------

export function parseArgoApp(obj: K): ArgoApp {
  const spec = obj.spec ?? {};
  const st = obj.status ?? {};
  const source = spec.source ?? spec.sources?.[0] ?? {};
  const automated = spec.syncPolicy?.automated;
  const resources: K[] = st.resources ?? [];
  const op = st.operationState;
  return {
    namespace: String(obj.metadata?.namespace ?? ""),
    name: String(obj.metadata?.name ?? ""),
    project: String(spec.project ?? "default"),
    sync: String(st.sync?.status ?? "Unknown"),
    health: String(st.health?.status ?? "Unknown"),
    healthMessage: st.health?.message ?? null,
    repo: source.repoURL ?? null,
    path: source.path ?? null,
    chart: source.chart ?? null,
    targetRevision: source.targetRevision ?? null,
    revision: st.sync?.revision ?? st.sync?.revisions?.[0] ?? null,
    destServer: spec.destination?.server ?? spec.destination?.name ?? null,
    destNamespace: spec.destination?.namespace ?? null,
    autoSync: automated !== undefined && automated !== null,
    selfHeal: automated?.selfHeal === true,
    prune: automated?.prune === true,
    operationPhase: op?.phase ?? null,
    operationMessage: op?.message ? String(op.message).slice(0, 1000) : null,
    operationStartedAt: op?.startedAt ?? null,
    lastSyncedAt: op?.finishedAt ?? st.history?.at?.(-1)?.deployedAt ?? null,
    reconciledAt: st.reconciledAt ?? null,
    conditions: (st.conditions ?? []).map((c: K) => ({
      type: String(c.type ?? ""),
      message: String(c.message ?? "").slice(0, 500),
    })),
    resources: resources
      .filter(
        (r) =>
          (r.status && r.status !== "Synced") ||
          (r.health?.status && r.health.status !== "Healthy"),
      )
      .slice(0, 50)
      .map((r) => ({
        kind: String(r.kind ?? ""),
        namespace: r.namespace ?? null,
        name: String(r.name ?? ""),
        status: r.status ?? null,
        health: r.health?.status ?? null,
        message: r.health?.message ?? null,
      })),
    resourceCount: resources.length,
    images: (st.summary?.images ?? []).map(String),
    createdAt: ts(obj.metadata?.creationTimestamp),
  };
}
