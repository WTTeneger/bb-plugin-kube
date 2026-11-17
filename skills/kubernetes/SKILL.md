---
name: kubernetes
description: Kubernetes from bb via `bb kube` and live ```kube-rollout status cards in chat. Use whenever a thread deploys or rolls out to Kubernetes (a "пролив", release, ArgoCD sync, image bump, rollout restart), checks whether pods were restarted, or analyses cluster health (failing or restarting pods, deployments, node load, PVC fill levels, ArgoCD sync state, port-forwards).
---

# Kubernetes (`bb kube`)

The Kubernetes plugin runs `kubectl` with the user's kubeconfig. Commands
without `--context` use the context and namespace selected in its sidebar.

## Show rollout status in the chat (do this on every deploy)

Whenever your work rolls something out to Kubernetes, or the user asks whether
pods were restarted, put a `kube-rollout` block in your reply. bb renders it
as a live card: per workload, "Restarted" / "Restarting 2/3" / "Not restarted
yet" / "Rollout failed", which pods are new or old, with logs. It refreshes
itself every few seconds until everything is done, so the user can watch the
rollout without asking.

```kube-rollout
context: my-cluster-prod
namespace: platform
since: 2026-11-17T17:05:00Z
title: Пролив 17.11 — партия 1
workloads: deployment/app-api, deployment/auth, sts/vault
```

- `context`: the kubeconfig context you deploy to (`kubectl config current-context`).
- `namespace`: required, one per block. Several namespaces → several blocks.
- `since`: UTC time the rollout started (take it right before you sync, merge
  or restart: `date -u +%Y-%m-%dT%H:%M:%SZ`). With it the card answers "was
  every pod replaced after this?". Without it the card shows rollout state only.
- `workloads`: `deployment/<name>`, `sts/<name>`, `ds/<name>` or a bare name
  (= deployment). Leave it out to show every workload in the namespace,
  problems first: use that for cluster analysis.
- `title`: optional, short.

Put the block in the reply that announces the rollout (one per batch), and in
the final summary. `bb kube rollout <namespace> <list> --since=<ISO> --context=<ctx>`
prints the current status and a ready-made block to paste.

Status meanings: Restarted = all live pods started after `since` and run the
current revision; Restarting n/m = some new pods are up, old ones still run;
Not restarted yet = every pod predates `since`; Rollout failed = progress
deadline exceeded; Not found = no such workload in that namespace.

## Read

- `bb kube status` — counts plus every unhealthy pod and degraded workload.
- `bb kube rollout <namespace> [kind/]<name>[,...] [--since=<ISO>] [--context=<ctx>]` — rollout status.
- `bb kube pods [--unhealthy]` — namespace, name, ready, status, restarts.
- `bb kube workloads` — deployments, statefulsets and daemonsets with ready/desired.
- `bb kube events` — the 50 latest warning events.
- `bb kube nodes` — per node CPU/memory used and requested vs allocatable.
- `bb kube pvc` — PVCs sorted by fill level.
- `bb kube argocd` — ArgoCD applications: sync, health, last operation.
- `bb kube pf` — port-forwards the plugin is running.
- Add `--json` for structured output.

For logs or anything else, call `kubectl` directly with an explicit `--context`.

## Change

- `bb kube select <context> [namespace|*]` — changes what the sidebar shows.
- `bb kube restart-pod <namespace> <pod>` — deletes the pod; its controller
  recreates it. A bare pod without an owner is NOT recreated.
- `bb kube rollout-restart <namespace> deployment/<name>` (also
  `statefulset/`, `daemonset/`).

Restarts act on real, often production, clusters. Run them only when the user
asked for that restart, and name the context and resource in your reply.
If the plugin's read-only mode is on, these commands fail; do not work around
it with raw kubectl unless the user says so. ArgoCD syncs, scaling, CronJob
runs and port-forwards are UI-only: point the user to the Kubernetes panel.
