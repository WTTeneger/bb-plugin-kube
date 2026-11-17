// Module-level stores shared by the badge, sidebar and page, so they issue
// one request per refresh instead of one per component.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRealtime, useRpc, type PluginRpcClient } from "@get-bb/plugin-sdk/app";
import { setLang } from "./i18n";
import type {
  Argo,
  Config,
  Metrics,
  PortForward,
  rpcContract,
  Snapshot,
  Storage,
} from "../contract";

export const ALL = "*";
export type Rpc = PluginRpcClient<typeof rpcContract>;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// bb can evaluate a plugin bundle more than once in one page (it does a
// second pass a few seconds after load). Each store's state and listeners
// live in a cell on globalThis, so every evaluation reads and updates the
// same data instead of one of them sitting on "Loading…".
const CACHE_VERSION = 3;
interface Cell {
  state: unknown;
  listeners: Set<() => void>;
}
const cells: Record<string, Cell> = (() => {
  const g = globalThis as unknown as { __bbKubeCells?: { v: number; cells: Record<string, Cell> } };
  if (!g.__bbKubeCells || g.__bbKubeCells.v !== CACHE_VERSION) g.__bbKubeCells = { v: CACHE_VERSION, cells: {} };
  return g.__bbKubeCells.cells;
})();

function createEmitter<T>(initial: T, key: string) {
  const cell = (cells[key] ??= { state: initial, listeners: new Set() });
  return {
    get: () => cell.state as T,
    set(patch: Partial<T>) {
      cell.state = { ...(cell.state as T), ...patch };
      for (const l of cell.listeners) l();
    },
    subscribe(l: () => void) {
      cell.listeners.add(l);
      return () => {
        cell.listeners.delete(l);
      };
    },
  };
}

let rpcClient: Rpc | null = null;
/** For surfaces outside the panel (chat blocks) that need dialogs. */
export function setRpcClient(client: Rpc) {
  if (!rpcClient) rpcClient = client;
}
export function getRpc(): Rpc {
  if (!rpcClient) throw new Error("Kubernetes plugin is not ready yet.");
  return rpcClient;
}

// ---------------------------------------------------------------------------
// Core: config + snapshot
// ---------------------------------------------------------------------------

interface CoreState {
  config: Config | null;
  snapshot: Snapshot | null;
  error: string | null;
  loading: boolean;
}

const BADGE_POLL_MS = 60_000;

export const core = (() => {
  const e = createEmitter<CoreState>({ config: null, snapshot: null, error: null, loading: false }, "core");
  let pageSubs = 0;
  let anySubs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let selectSeq = 0;
  let selectChain: Promise<void> = Promise.resolve();

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (anySubs === 0) return;
    const fast = (e.get().config?.refreshSeconds ?? 15) * 1000;
    const ms = pageSubs > 0 && fast > 0 ? fast : BADGE_POLL_MS;
    timer = setTimeout(() => void refresh(), ms);
  }

  async function refresh(opts: { force?: boolean; config?: boolean } = {}): Promise<void> {
    if (!rpcClient) return;
    if (inflight && !opts.force && !opts.config) return inflight;
    const rpc = rpcClient;
    const run = (async () => {
      e.set({ loading: true });
      try {
        let config = e.get().config;
        if (!config || opts.config) {
          config = await rpc.call("config", null);
          setLang(config.language);
          e.set({ config });
        }
        if (!config.selection) {
          e.set({ error: config.error ?? "No Kubernetes context selected.", snapshot: null });
          return;
        }
        const snapshot = await rpc.call("snapshot", { force: opts.force === true });
        const now = e.get().config?.selection;
        // Drop a late answer for a scope the user already left.
        if (!now || (now.context === snapshot.selection.context && now.namespace === snapshot.selection.namespace)) {
          e.set({ snapshot, error: null });
        }
      } catch (err) {
        e.set({ error: message(err) });
      } finally {
        e.set({ loading: false });
        schedule();
      }
    })();
    inflight = run;
    void run.finally(() => {
      if (inflight === run) inflight = null;
    });
    return run;
  }

  return {
    ...e,
    refresh,
    attach(client: Rpc, page: boolean) {
      rpcClient = client;
      anySubs += 1;
      if (page) pageSubs += 1;
      const snap = e.get().snapshot;
      const stale = !snap || Date.now() - Date.parse(snap.fetchedAt) > 10_000;
      if (stale && !inflight) void refresh();
      else if (page) schedule();
      return () => {
        anySubs -= 1;
        if (page) pageSubs -= 1;
        schedule();
      };
    },
    /**
     * Change the server-side scope. Calls are serialized: each compares
     * against the scope the previous call left, so quick successive picks
     * (one namespace, then a second) end on the last one.
     */
    select(context: string, namespace: string): Promise<void> {
      const seq = ++selectSeq;
      selectChain = selectChain.then(async () => {
        if (seq !== selectSeq) return; // a newer pick supersedes this one
        const current = e.get().config?.selection;
        if (current && current.context === context && current.namespace === namespace) return;
        e.set({ snapshot: current?.context === context ? e.get().snapshot : null, loading: true });
        try {
          await getRpc().call("select", { context, namespace });
          const config = e.get().config;
          if (config) e.set({ config: { ...config, selection: { context, namespace } } });
        } catch (err) {
          e.set({ error: message(err), loading: false });
          return;
        }
        await refresh({ config: true, force: true });
      });
      return selectChain;
    },
  };
})();

export function useKube(page: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const state = useSyncExternalStore(core.subscribe, core.get, core.get);
  useEffect(() => core.attach(rpc, page), [rpc, page]);
  return { rpc, ...state };
}

/** Mount once (in the page and the sidebar): server change signals. */
export function useKubeRealtime() {
  useRealtime("kube-changed", () => {
    void core.refresh({ config: true });
    for (const r of Object.values(resources)) r.invalidate();
  });
  useRealtime("kube-pf-changed", () => void portForwards.refresh());
}

// ---------------------------------------------------------------------------
// Filters: namespaces (multi) + text query + optional pivots
// ---------------------------------------------------------------------------

export interface Filters {
  namespaces: string[]; // empty = all
  query: string;
  workload: { namespace: string; kind: string; name: string } | null;
  node: string | null;
  problemsOnly: boolean;
}

const EMPTY_FILTERS: Filters = { namespaces: [], query: "", workload: null, node: null, problemsOnly: false };

function storageKey(context: string) {
  return `bb-kube.filters.${context}`;
}

export const filters = (() => {
  const e = createEmitter<Filters>(EMPTY_FILTERS, "filters");
  const meta = createEmitter<{ loadedFor: string | null }>({ loadedFor: null }, "filters-meta");

  function persist(context: string | undefined) {
    if (!context) return;
    try {
      const { namespaces, problemsOnly } = e.get();
      localStorage.setItem(storageKey(context), JSON.stringify({ namespaces, problemsOnly }));
    } catch {
      /* storage unavailable */
    }
  }

  return {
    ...e,
    /** Load the saved namespace choice when the context changes. */
    loadFor(context: string) {
      if (meta.get().loadedFor === context) return;
      meta.set({ loadedFor: context });
      let saved: Partial<Filters> = {};
      try {
        saved = JSON.parse(localStorage.getItem(storageKey(context)) ?? "{}") as Partial<Filters>;
      } catch {
        saved = {};
      }
      e.set({
        ...EMPTY_FILTERS,
        namespaces: Array.isArray(saved.namespaces) ? saved.namespaces.filter((n) => typeof n === "string") : [],
        problemsOnly: saved.problemsOnly === true,
      });
      // Bring the server's fetch scope in line with the restored choice.
      const ns = e.get().namespaces;
      void core.select(context, ns.length === 1 ? ns[0]! : ALL);
    },
    update(patch: Partial<Filters>) {
      e.set(patch);
      const context = core.get().config?.selection?.context;
      persist(context);
      if (patch.namespaces && context) {
        // One namespace: ask the server for just that one (faster on big
        // clusters). Several or none: fetch everything, filter here.
        const ns = patch.namespaces.length === 1 ? patch.namespaces[0]! : ALL;
        void core.select(context, ns);
      }
    },
    clearPivots() {
      e.set({ workload: null, node: null, query: "" });
    },
  };
})();

export function useFilters(): Filters {
  return useSyncExternalStore(filters.subscribe, filters.get, filters.get);
}

/** Returns predicates for the active filters. */
export function useMatchers() {
  const f = useFilters();
  const tokens = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const ns = useCallback(
    (namespace: string | null | undefined) =>
      f.namespaces.length === 0 || (namespace != null && f.namespaces.includes(namespace)),
    [f.namespaces],
  );
  const text = useCallback(
    (haystack: string) => {
      if (tokens.length === 0) return true;
      const h = haystack.toLowerCase();
      return tokens.every((t) => h.includes(t));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [f.query],
  );
  return { filters: f, ns, text };
}

// ---------------------------------------------------------------------------
// Lazily loaded resources: metrics, storage, argocd
// ---------------------------------------------------------------------------

interface ResourceState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  key: string | null; // selection the data belongs to
}

type ResourceMethod = "metrics" | "storage" | "argocd";
type ResourceData = { metrics: Metrics; storage: Storage; argocd: Argo };

function createResource<M extends ResourceMethod>(method: M, intervalMs: number) {
  const e = createEmitter<ResourceState<ResourceData[M]>>(
    { data: null, error: null, loading: false, key: null },
    `resource:${method}`,
  );
  let subs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;

  const selectionKey = () => {
    const s = core.get().config?.selection;
    return s ? `${s.context}\u0000${s.namespace}` : null;
  };

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (subs > 0) timer = setTimeout(() => void load(), intervalMs);
  }

  async function load(force = false): Promise<void> {
    if (!rpcClient || !core.get().config?.selection) return;
    if (inflight && !force) return inflight;
    const key = selectionKey();
    const run = (async () => {
      e.set({ loading: true, ...(e.get().key !== key ? { data: null } : {}) });
      try {
        const data = (await rpcClient!.call(method, { force })) as ResourceData[M];
        if (selectionKey() === key) e.set({ data, error: null, key });
      } catch (err) {
        e.set({ error: message(err) });
      } finally {
        e.set({ loading: false });
        schedule();
      }
    })();
    inflight = run;
    void run.finally(() => {
      if (inflight === run) inflight = null;
    });
    return run;
  }

  // Reload when the selection changes.
  let lastKey: string | null = null;
  core.subscribe(() => {
    const key = selectionKey();
    if (key !== lastKey) {
      lastKey = key;
      if (subs > 0) void load(true);
    }
  });

  return {
    ...e,
    load,
    invalidate() {
      if (subs > 0) void load(true);
    },
    attach() {
      subs += 1;
      const s = e.get();
      if (!s.data || s.key !== selectionKey()) void load();
      else schedule();
      return () => {
        subs -= 1;
        schedule();
      };
    },
  };
}

export const resources = {
  metrics: createResource("metrics", 20_000),
  storage: createResource("storage", 60_000),
  argocd: createResource("argocd", 15_000),
};

export function useResource<M extends ResourceMethod>(method: M) {
  const r = resources[method] as unknown as ReturnType<typeof createResource<M>>;
  const state = useSyncExternalStore(r.subscribe, r.get, r.get);
  const { config } = useSyncExternalStore(core.subscribe, core.get, core.get);
  useEffect(() => (config?.selection ? r.attach() : undefined), [r, config?.selection]);
  return { ...state, reload: () => void r.load(true) };
}

// ---------------------------------------------------------------------------
// Port-forwards
// ---------------------------------------------------------------------------

export const portForwards = (() => {
  const e = createEmitter<{ list: PortForward[]; loaded: boolean }>({ list: [], loaded: false }, "portForwards");
  return {
    ...e,
    async refresh() {
      if (!rpcClient) return;
      try {
        const { forwards } = await rpcClient.call("pf_list", null);
        e.set({ list: forwards, loaded: true });
      } catch {
        /* keep the last list */
      }
    },
  };
})();

export function usePortForwards() {
  const state = useSyncExternalStore(portForwards.subscribe, portForwards.get, portForwards.get);
  useEffect(() => {
    if (!state.loaded) void portForwards.refresh();
  }, [state.loaded]);
  return state.list;
}
