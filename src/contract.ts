// Wire contract shared by server.ts (handlers) and the UI (types only).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const ALL_NAMESPACES = "*";

export const selectionSchema = z.object({
  context: z.string(),
  namespace: z.string(), // "*" = all namespaces
});
export type Selection = z.infer<typeof selectionSchema>;

const portSchema = z.object({
  name: z.string().nullable(),
  port: z.number(),
  protocol: z.string(),
});
export type ContainerPort = z.infer<typeof portSchema>;

const containerSchema = z.object({
  name: z.string(),
  image: z.string(),
  ready: z.boolean(),
  restarts: z.number(),
  state: z.string(),
  reason: z.string().nullable(),
  ports: z.array(portSchema),
});

const workloadRefSchema = z.object({
  kind: z.string(), // Deployment, StatefulSet, DaemonSet, Job, CronJob, ReplicaSet, Node…
  name: z.string(),
});
export type WorkloadRef = z.infer<typeof workloadRefSchema>;

const podSchema = z.object({
  namespace: z.string(),
  name: z.string(),
  phase: z.string(),
  status: z.string(), // kubectl-style STATUS column (CrashLoopBackOff, …)
  ready: z.string(), // "1/2"
  restarts: z.number(),
  lastRestartAt: z.string().nullable(),
  node: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.string(),
  owner: z.string().nullable(), // "ReplicaSet/foo-abc"
  workload: workloadRefSchema.nullable(), // resolved top-level controller
  healthy: z.boolean(),
  terminated: z.boolean(), // Succeeded/Failed: does not hold node resources
  containers: z.array(containerSchema),
  pvcs: z.array(z.string()),
  cpuRequest: z.number(), // millicores
  cpuLimit: z.number(),
  memRequest: z.number(), // bytes
  memLimit: z.number(),
});
export type Pod = z.infer<typeof podSchema>;

const workloadSchema = z.object({
  kind: z.enum(["Deployment", "StatefulSet", "DaemonSet"]),
  namespace: z.string(),
  name: z.string(),
  desired: z.number(),
  ready: z.number(),
  updated: z.number(),
  available: z.number(),
  images: z.array(z.string()),
  createdAt: z.string(),
  healthy: z.boolean(),
  progressing: z.boolean(),
  message: z.string().nullable(),
  selector: z.string().nullable(), // label selector for `kubectl logs -l`
  revision: z.string().nullable(), // Deployment revision, StatefulSet updateRevision, DaemonSet generation
  updatedAt: z.string().nullable(), // last rollout progress (Deployments); null otherwise
});
export type Workload = z.infer<typeof workloadSchema>;

const jobSchema = z.object({
  kind: z.enum(["Job", "CronJob"]),
  namespace: z.string(),
  name: z.string(),
  status: z.string(),
  schedule: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  suspended: z.boolean(),
  healthy: z.boolean(),
  createdAt: z.string(),
});
export type Job = z.infer<typeof jobSchema>;

const servicePortSchema = z.object({
  name: z.string().nullable(),
  port: z.number(),
  targetPort: z.string().nullable(),
  nodePort: z.number().nullable(),
  protocol: z.string(),
});
export type ServicePort = z.infer<typeof servicePortSchema>;

const serviceSchema = z.object({
  namespace: z.string(),
  name: z.string(),
  type: z.string(),
  clusterIP: z.string().nullable(),
  externalIP: z.string().nullable(),
  ports: z.array(servicePortSchema),
  createdAt: z.string(),
});
export type Service = z.infer<typeof serviceSchema>;

const ingressSchema = z.object({
  namespace: z.string(),
  name: z.string(),
  className: z.string().nullable(),
  hosts: z.array(z.string()),
  address: z.string().nullable(),
  createdAt: z.string(),
});
export type Ingress = z.infer<typeof ingressSchema>;

const nodeSchema = z.object({
  name: z.string(),
  ready: z.boolean(),
  roles: z.string(),
  version: z.string(),
  cpuAllocatable: z.number(), // millicores
  memAllocatable: z.number(), // bytes
  podCapacity: z.number(),
  pods: z.number(),
  unschedulable: z.boolean(),
  pressure: z.array(z.string()),
  taints: z.array(z.string()),
  instanceType: z.string().nullable(),
  zone: z.string().nullable(),
  pool: z.string().nullable(),
  internalIP: z.string().nullable(),
  osImage: z.string(),
  kernel: z.string(),
  runtime: z.string(),
  createdAt: z.string(),
});
export type KubeNode = z.infer<typeof nodeSchema>;

const eventSchema = z.object({
  namespace: z.string(),
  type: z.string(),
  reason: z.string(),
  object: z.string(),
  message: z.string(),
  count: z.number(),
  lastSeen: z.string().nullable(),
});
export type KubeEvent = z.infer<typeof eventSchema>;

const snapshotSchema = z.object({
  selection: selectionSchema,
  fetchedAt: z.string(),
  pods: z.array(podSchema),
  workloads: z.array(workloadSchema),
  jobs: z.array(jobSchema),
  services: z.array(serviceSchema),
  ingresses: z.array(ingressSchema),
  nodes: z.array(nodeSchema),
  events: z.array(eventSchema),
  errors: z.array(z.string()), // per-resource failures (e.g. RBAC forbidden)
});
export type Snapshot = z.infer<typeof snapshotSchema>;

// ---- metrics (metrics-server) -------------------------------------------

const metricsSchema = z.object({
  available: z.boolean(),
  error: z.string().nullable(),
  fetchedAt: z.string(),
  nodes: z.array(z.object({ name: z.string(), cpu: z.number(), mem: z.number() })),
  pods: z.array(
    z.object({ namespace: z.string(), name: z.string(), cpu: z.number(), mem: z.number() }),
  ),
});
export type Metrics = z.infer<typeof metricsSchema>;

// ---- storage ---------------------------------------------------------------

const pvcSchema = z.object({
  namespace: z.string(),
  name: z.string(),
  status: z.string(),
  capacityBytes: z.number().nullable(),
  requestBytes: z.number().nullable(),
  storageClass: z.string().nullable(),
  accessModes: z.array(z.string()),
  volume: z.string().nullable(),
  volumeMode: z.string().nullable(),
  createdAt: z.string(),
  usedBytes: z.number().nullable(), // from kubelet stats, when mounted
  availableBytes: z.number().nullable(),
  inodesUsedPct: z.number().nullable(),
  resizing: z.boolean(),
  node: z.string().nullable(), // node whose kubelet reports the mount
});
export type Pvc = z.infer<typeof pvcSchema>;

const pvSchema = z.object({
  name: z.string(),
  status: z.string(),
  capacityBytes: z.number().nullable(),
  claim: z.string().nullable(),
  storageClass: z.string().nullable(),
  reclaimPolicy: z.string().nullable(),
  createdAt: z.string(),
});
export type Pv = z.infer<typeof pvSchema>;

const storageClassSchema = z.object({
  name: z.string(),
  provisioner: z.string(),
  isDefault: z.boolean(),
  reclaimPolicy: z.string().nullable(),
  allowExpansion: z.boolean(),
  bindingMode: z.string().nullable(),
});
export type StorageClass = z.infer<typeof storageClassSchema>;

const nodeDiskSchema = z.object({
  name: z.string(),
  capacityBytes: z.number().nullable(), // root filesystem (nodefs)
  usedBytes: z.number().nullable(),
  availableBytes: z.number().nullable(),
  inodesUsedPct: z.number().nullable(),
  imagesBytes: z.number().nullable(), // container images (imagefs, often the same disk)
  imageFsSeparate: z.boolean(),
  imageFsCapacityBytes: z.number().nullable(),
  /** Pods writing most to the node's disk (logs, emptyDir, writable layer). */
  topEphemeral: z.array(z.object({ namespace: z.string(), name: z.string(), usedBytes: z.number() })),
});
export type NodeDisk = z.infer<typeof nodeDiskSchema>;

const storageSchema = z.object({
  fetchedAt: z.string(),
  nodeDisks: z.array(nodeDiskSchema),
  pvcs: z.array(pvcSchema),
  pvs: z.array(pvSchema),
  storageClasses: z.array(storageClassSchema),
  usageAvailable: z.boolean(),
  errors: z.array(z.string()),
});
export type Storage = z.infer<typeof storageSchema>;

// ---- ArgoCD ----------------------------------------------------------------

const argoResourceSchema = z.object({
  kind: z.string(),
  namespace: z.string().nullable(),
  name: z.string(),
  status: z.string().nullable(),
  health: z.string().nullable(),
  message: z.string().nullable(),
});

const argoAppSchema = z.object({
  namespace: z.string(),
  name: z.string(),
  project: z.string(),
  sync: z.string(),
  health: z.string(),
  healthMessage: z.string().nullable(),
  repo: z.string().nullable(),
  path: z.string().nullable(),
  chart: z.string().nullable(),
  targetRevision: z.string().nullable(),
  revision: z.string().nullable(),
  destServer: z.string().nullable(),
  destNamespace: z.string().nullable(),
  autoSync: z.boolean(),
  selfHeal: z.boolean(),
  prune: z.boolean(),
  operationPhase: z.string().nullable(),
  operationMessage: z.string().nullable(),
  operationStartedAt: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  reconciledAt: z.string().nullable(),
  conditions: z.array(z.object({ type: z.string(), message: z.string() })),
  resources: z.array(argoResourceSchema), // only out-of-sync / unhealthy ones
  resourceCount: z.number(),
  images: z.array(z.string()),
  createdAt: z.string(),
});
export type ArgoApp = z.infer<typeof argoAppSchema>;

const argoSchema = z.object({
  installed: z.boolean(),
  error: z.string().nullable(),
  fetchedAt: z.string(),
  apps: z.array(argoAppSchema),
});
export type Argo = z.infer<typeof argoSchema>;

// ---- port-forward -----------------------------------------------------------

export const portForwardSchema = z.object({
  id: z.string(),
  context: z.string(),
  namespace: z.string(),
  kind: z.enum(["pod", "service", "deployment", "statefulset"]),
  name: z.string(),
  remotePort: z.number(),
  localPort: z.number().nullable(),
  status: z.enum(["starting", "running", "stopped", "error"]),
  error: z.string().nullable(),
  startedAt: z.string(),
  connections: z.number(),
});
export type PortForward = z.infer<typeof portForwardSchema>;

// ---- inputs ---------------------------------------------------------------


export const nameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, "Not a valid Kubernetes name");
export const contextSchema = z.string().min(1).max(512);
export const targetSchema = z.object({
  context: contextSchema,
  namespace: nameSchema,
  name: nameSchema,
});
export type Target = z.infer<typeof targetSchema>;

// ---- rollout status (```kube-rollout blocks) --------------------------------

export const rolloutKindSchema = z.enum(["Deployment", "StatefulSet", "DaemonSet"]);

export const rolloutInputSchema = z.object({
  context: z.string().min(1).max(512),
  namespace: nameSchema,
  workloads: z
    .array(z.object({ kind: rolloutKindSchema, name: nameSchema }))
    .max(60),
  since: z.string().max(64).optional(),
});
export type RolloutInput = z.infer<typeof rolloutInputSchema>;

const rolloutPodSchema = z.object({
  name: z.string(),
  status: z.string(),
  ready: z.string(),
  healthy: z.boolean(),
  restarts: z.number(),
  lastRestartAt: z.string().nullable(),
  createdAt: z.string(),
  node: z.string().nullable(),
  image: z.string().nullable(),
  current: z.boolean(), // runs the workload's current revision
  fresh: z.boolean().nullable(), // started after `since`; null without `since`
});
export type RolloutPod = z.infer<typeof rolloutPodSchema>;

const rolloutWorkloadSchema = z.object({
  kind: rolloutKindSchema,
  name: z.string(),
  found: z.boolean(),
  desired: z.number(),
  ready: z.number(),
  updated: z.number(),
  available: z.number(),
  revision: z.string().nullable(),
  images: z.array(z.string()),
  restartedAt: z.string().nullable(), // kubectl rollout restart annotation
  state: z.enum(["complete", "progressing", "failed", "missing", "scaled-to-zero"]),
  selector: z.string().nullable(), // label selector, for `kubectl logs -l`
  /** With `since`: has every pod been replaced since then? */
  restarted: z.enum(["yes", "partial", "no"]).nullable(),
  message: z.string().nullable(),
  pods: z.array(rolloutPodSchema),
});
export type RolloutWorkload = z.infer<typeof rolloutWorkloadSchema>;

export const rolloutOutputSchema = z.object({
  context: z.string(),
  namespace: z.string(),
  since: z.string().nullable(),
  fetchedAt: z.string(),
  workloads: z.array(rolloutWorkloadSchema),
  error: z.string().nullable(),
});
export type RolloutStatus = z.infer<typeof rolloutOutputSchema>;


const configSchema = z.object({
  contexts: z.array(z.string()),
  kubeconfigCurrent: z.string().nullable(),
  selection: selectionSchema.nullable(),
  readOnly: z.boolean(),
  refreshSeconds: z.number(),
  language: z.enum(["en", "ru"]),
  error: z.string().nullable(),
});
export type Config = z.infer<typeof configSchema>;

const textSchema = z.object({ text: z.string() });
const messageSchema = z.object({ message: z.string() });

export const rpcContract = defineRpcContract({
  config: { input: z.null(), output: configSchema },
  namespaces: {
    input: z.object({ context: contextSchema }),
    output: z.object({ namespaces: z.array(z.string()) }),
  },
  select: { input: selectionSchema, output: selectionSchema },
  snapshot: { input: z.object({ force: z.boolean().optional() }), output: snapshotSchema },
  metrics: { input: z.object({ force: z.boolean().optional() }), output: metricsSchema },
  storage: { input: z.object({ force: z.boolean().optional() }), output: storageSchema },
  argocd: { input: z.object({ force: z.boolean().optional() }), output: argoSchema },

  pod_logs: {
    input: targetSchema.extend({
      container: z.string().max(253).optional(),
      previous: z.boolean().optional(),
      tail: z.number().int().min(10).max(5000).optional(),
    }),
    output: textSchema,
  },
  workload_logs: {
    input: targetSchema.extend({
      selector: z.string().min(1).max(2000),
      tail: z.number().int().min(10).max(2000).optional(),
    }),
    output: textSchema,
  },
  describe: {
    input: targetSchema.extend({
      kind: z.enum([
        "pod",
        "deployment",
        "statefulset",
        "daemonset",
        "job",
        "cronjob",
        "service",
        "ingress",
        "node",
        "persistentvolumeclaim",
        "persistentvolume",
        "applications.argoproj.io",
      ]),
    }),
    output: textSchema,
  },
  pod_restart: { input: targetSchema, output: messageSchema },
  rollout_restart: {
    input: targetSchema.extend({ kind: z.enum(["Deployment", "StatefulSet", "DaemonSet"]) }),
    output: messageSchema,
  },
  scale: {
    input: targetSchema.extend({
      kind: z.enum(["Deployment", "StatefulSet"]),
      replicas: z.number().int().min(0).max(1000),
    }),
    output: messageSchema,
  },
  cronjob_trigger: { input: targetSchema, output: messageSchema },

  argocd_sync: {
    input: targetSchema.extend({ prune: z.boolean() }),
    output: messageSchema,
  },
  argocd_refresh: {
    input: targetSchema.extend({ hard: z.boolean() }),
    output: messageSchema,
  },

  pf_list: { input: z.null(), output: z.object({ forwards: z.array(portForwardSchema) }) },
  pf_start: {
    input: targetSchema.extend({
      kind: z.enum(["pod", "service", "deployment", "statefulset"]),
      remotePort: z.number().int().min(1).max(65535),
      localPort: z.number().int().min(0).max(65535).optional(),
    }),
    output: portForwardSchema,
  },
  pf_stop: { input: z.object({ id: z.string().max(64) }), output: messageSchema },

  set_language: { input: z.object({ language: z.enum(["en", "ru"]) }), output: z.object({ language: z.enum(["en", "ru"]) }) },

  rollout_status: { input: rolloutInputSchema, output: rolloutOutputSchema },
  contexts: { input: z.null(), output: z.object({ contexts: z.array(z.string()), current: z.string().nullable() }) },
});
