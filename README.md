# Kubernetes for bb

A [bb](https://getbb.app) plugin that puts your clusters in the sidebar: pods
and restarts, deployments, ArgoCD, node load and disk, PVC fill levels,
port-forwards, and live rollout cards inside agent threads. English and
Russian interface.

See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for the full feature list.

## Install

From the bb plugin store (Community), or from source:

    git clone https://github.com/WTTeneger/bb-plugin-kube.git
    cd bb-plugin-kube
    npm install
    bb plugin install .

## Requirements

- `kubectl` on the machine that runs bb, plus any credential plugin your
  kubeconfig uses (doctl, aws, gke-gcloud-auth-plugin, …). Homebrew paths are
  searched even when bb was started from the Dock.
- metrics-server for live CPU and memory (requests and limits work without it).
- `get` on `nodes/proxy` for node disk and PVC fill levels (kubelet stats).
- ArgoCD is optional; the plugin reads `applications.argoproj.io` with
  kubectl, no ArgoCD CLI or token.

## Settings (`bb plugin config kube`)

| Key | Default | Meaning |
| --- | --- | --- |
| `kubectlPath` | empty | kubectl binary; empty searches PATH plus Homebrew |
| `kubeconfig` | empty | KUBECONFIG value; empty uses `~/.kube/config` |
| `readOnly` | `false` | hide and refuse restarts, scaling, job runs, ArgoCD syncs |
| `refreshSeconds` | `15` | refresh interval of an open page (the badge polls every 60 s) |
| `language` | `en` | `en` or `ru`; also switchable from the panel toolbar |

The plugin never changes your kubeconfig's current context: it passes an
explicit `--context` on every call and keeps its own selection.

## Rollout cards in chat

Any agent message may contain:

    ```kube-rollout
    context: my-cluster-prod
    namespace: platform
    since: 2026-11-17T17:05:00Z
    workloads: deployment/app-api, auth, sts/vault
    ```

bb renders it as a live card (Restarted / Restarting n/m / Not restarted yet /
Rollout failed per workload, new and old pods, logs) that refreshes every 5 s
until everything is done. Without `workloads` it shows the whole namespace.
`bb kube rollout <ns> <list> --since=<ISO>` prints the status and a ready
block. The bundled skill tells agents to add the block on every deploy.

## CLI for agents

    bb kube status | pods [--unhealthy] | workloads | events | nodes | pvc | argocd | pf
    bb kube rollout <namespace> [kind/]<name>[,...] [--since=<ISO>] [--context=<ctx>]
    bb kube select <context> [namespace|*]
    bb kube restart-pod <namespace> <pod>
    bb kube rollout-restart <namespace> <kind>/<name>

Every command takes `--json`.

## Layout

- `server.ts` — kubectl runner, caches, mutations, RPC handlers, `bb kube` CLI.
- `src/contract.ts` — RPC contract and wire types (shared with the UI).
- `src/parse.ts` — kubectl JSON to wire types, CPU and memory quantities.
- `src/rollout.ts` — rollout status: rolled out, which pods are new since a time.
- `src/portforward.ts` — `kubectl port-forward` process manager.
- `app.tsx` — registers the nav panel and the `kube-rollout` code-fence renderer.
- `src/ui/` — `store.ts` (shared state, filters), `i18n.ts` (`L("en", "ru")`),
  `sidebar.tsx` (toolbar), `page.tsx` (overview, header, badge),
  `dialogs.tsx` (logs, confirm, port-forward), `rollout-block.tsx` and
  `rollout-parse.ts` (chat cards), `sections/` (pods and deployments, nodes,
  storage, argocd, rollout check, the rest).
- `icons.tsx` — Lucide glyphs (ISC) registered as `kube-*`.
- `skills/kubernetes/SKILL.md` — how agents use `bb kube` and rollout cards.
- `tests/` — `npm test` (node --test).

## Development

    npm install
    npm test
    npx tsc --noEmit -p .
    bb plugin build
    bb plugin dev        # rebuild and reload on save

## License

MIT
