import { L } from "./i18n.ts";
// Parser for ```kube-rollout fence bodies: "key: value" lines or JSON.
// Pure (no React), so it is easy to test.
type Kind = "Deployment" | "StatefulSet" | "DaemonSet";
// ---- parsing the fence body ----------------------------------------------------

export interface BlockSpec {
  context: string | null;
  namespace: string;
  since: string | null;
  title: string | null;
  workloads: { kind: Kind; name: string }[];
}

const KIND_ALIASES: Record<string, Kind> = {
  deployment: "Deployment",
  deployments: "Deployment",
  deploy: "Deployment",
  statefulset: "StatefulSet",
  statefulsets: "StatefulSet",
  sts: "StatefulSet",
  daemonset: "DaemonSet",
  daemonsets: "DaemonSet",
  ds: "DaemonSet",
};

const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

function parseRef(ref: string, defaultKind: Kind): { kind: Kind; name: string } | null {
  const clean = ref.trim().replace(/^[-*]\s*/, "").replace(/^["']|["']$/g, "");
  if (!clean) return null;
  const [k, n] = clean.includes("/") ? clean.split("/", 2) : [null, clean];
  const kind = k ? KIND_ALIASES[k.toLowerCase()] : defaultKind;
  if (!kind || !n || !NAME_RE.test(n)) return null;
  return { kind, name: n };
}

export function parseBlock(code: string): BlockSpec | { error: string } {
  const text = code.trim();
  const spec: BlockSpec = { context: null, namespace: "", since: null, title: null, workloads: [] };
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      spec.context = typeof j.context === "string" ? j.context : null;
      spec.namespace = String(j.namespace ?? j.ns ?? "");
      spec.since = typeof j.since === "string" ? j.since : null;
      spec.title = typeof j.title === "string" ? j.title : null;
      for (const [key, kind] of Object.entries({ workloads: "Deployment", deployments: "Deployment", statefulsets: "StatefulSet", daemonsets: "DaemonSet" } as const)) {
        const list = j[key];
        if (Array.isArray(list)) for (const r of list) {
          const w = parseRef(String(r), kind);
          if (w) spec.workloads.push(w);
        }
      }
    } catch (e) {
      return { error: L(`Invalid JSON: ${(e as Error).message}`, `Неверный JSON: ${(e as Error).message}`) };
    }
  } else {
    let listKind: Kind | null = null;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = /^([a-zA-Z]+)\s*:\s*(.*)$/.exec(line);
      if (m && !line.startsWith("-")) {
        const key = m[1]!.toLowerCase();
        const value = m[2]!.trim();
        listKind = null;
        if (key === "context") spec.context = value || null;
        else if (key === "namespace" || key === "ns") spec.namespace = value;
        else if (key === "since" || key === "started") spec.since = value || null;
        else if (key === "title") spec.title = value || null;
        else if (key === "workloads" || KIND_ALIASES[key]) {
          listKind = KIND_ALIASES[key] ?? "Deployment";
          for (const r of value.split(",")) {
            const w = parseRef(r, listKind);
            if (w) spec.workloads.push(w);
          }
        }
      } else if (listKind && line.startsWith("-")) {
        const w = parseRef(line, listKind);
        if (w) spec.workloads.push(w);
      }
    }
  }
  if (!NAME_RE.test(spec.namespace)) return { error: L("namespace: is required", "нужно указать namespace:") };
  if (spec.since && !Number.isFinite(Date.parse(spec.since))) return { error: L(`since: "${spec.since}" is not a date`, `since: "${spec.since}" — не дата`) };
  const seen = new Set<string>();
  spec.workloads = spec.workloads.filter((w) => !seen.has(`${w.kind}/${w.name}`) && seen.add(`${w.kind}/${w.name}`)).slice(0, 60);
  return spec;
}

