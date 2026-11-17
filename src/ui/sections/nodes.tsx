// Node analytics: real usage (metrics-server) against requests, limits and
// allocatable capacity, per node and per node pool.
import { useMemo, useState } from "react";
import type { KubeNode, Metrics, NodeDisk, Pod, Pvc } from "../../contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { actions } from "../dialogs";
import {
  ActionButton,
  ago,
  Chip,
  fmtBytes,
  fmtCpu,
  fmtPct,
  Hint,
  IconButton,
  Metric,
  NativeSelect,
  pct,
  SectionCard,
  StatusPill,
  td,
  textClass,
  th,
  toneForUsage,
  UsageBar,
  UsageRow,
  useGo,
  useNow,
  type Tone,
} from "../shared";
import { filters, useMatchers, useResource } from "../store";
import type { SectionProps } from "./workloads";
import { L } from "../i18n";

interface NodeStats {
  node: KubeNode;
  pods: Pod[];
  cpuUsed: number | null;
  memUsed: number | null;
  cpuReq: number;
  cpuLim: number;
  memReq: number;
  memLim: number;
}

export function computeNodeStats(nodes: KubeNode[], pods: Pod[], metrics: Metrics | null): NodeStats[] {
  const byNode = new Map<string, Pod[]>();
  for (const p of pods) {
    if (!p.node || p.terminated) continue;
    byNode.set(p.node, [...(byNode.get(p.node) ?? []), p]);
  }
  return nodes.map((node) => {
    const ps = byNode.get(node.name) ?? [];
    const usage = metrics?.nodes.find((n) => n.name === node.name);
    return {
      node,
      pods: ps,
      cpuUsed: usage?.cpu ?? null,
      memUsed: usage?.mem ?? null,
      cpuReq: ps.reduce((a, p) => a + p.cpuRequest, 0),
      cpuLim: ps.reduce((a, p) => a + p.cpuLimit, 0),
      memReq: ps.reduce((a, p) => a + p.memRequest, 0),
      memLim: ps.reduce((a, p) => a + p.memLimit, 0),
    };
  });
}

function nodeTone(s: NodeStats): Tone {
  if (!s.node.ready) return "bad";
  if (s.node.pressure.length || s.node.unschedulable) return "warn";
  const peak = Math.max(pct(s.cpuUsed, s.node.cpuAllocatable) ?? 0, pct(s.memUsed, s.node.memAllocatable) ?? 0);
  return toneForUsage(peak) === "bad" ? "warn" : "good";
}

function sum<T>(items: T[], f: (t: T) => number | null) {
  return items.reduce((a, t) => a + (f(t) ?? 0), 0);
}

/** Root filesystem of a node: used / capacity, images, inodes. */
function DiskRow({ disk, loading }: { disk: NodeDisk | null; loading: boolean }) {
  if (!disk || disk.capacityBytes === null) {
    return (
      <div className="flex items-baseline gap-2 text-xs">
        <span className="w-14 shrink-0 text-muted-foreground">{L("Disk", "Диск")}</span>
        <span className="text-muted-foreground">{loading ? L("loading…", "загрузка…") : L("no kubelet stats (needs nodes/proxy)", "нет статистики kubelet (нужен доступ к nodes/proxy)")}</span>
      </div>
    );
  }
  const used = pct(disk.usedBytes, disk.capacityBytes);
  const inodesHot = (disk.inodesUsedPct ?? 0) >= 80;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="w-14 shrink-0 text-muted-foreground">{L("Disk", "Диск")}</span>
        <span className={cn("font-medium tabular-nums", textClass[toneForUsage(used)])}>{fmtPct(used)}</span>
        <span className="min-w-0 flex-1 truncate text-right tabular-nums text-muted-foreground">
          {L(`${fmtBytes(disk.usedBytes)} of ${fmtBytes(disk.capacityBytes)} · ${fmtBytes(disk.availableBytes)} free`, `${fmtBytes(disk.usedBytes)} из ${fmtBytes(disk.capacityBytes)} · свободно ${fmtBytes(disk.availableBytes)}`)}
        </span>
      </div>
      <UsageBar value={used} marker={disk.imageFsSeparate ? null : pct(disk.imagesBytes, disk.capacityBytes)} />
      <div className="flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
        <Hint label={disk.imageFsSeparate ? L("Container images live on a separate disk", "Образы контейнеров лежат на отдельном диске") : L("Container images on this disk (tick on the bar)", "Образы контейнеров на этом диске (риска на полосе)")}>
          <span>
            {L("images", "образы")} {fmtBytes(disk.imagesBytes)}
            {disk.imageFsSeparate ? L(` of ${fmtBytes(disk.imageFsCapacityBytes)} (separate disk)`, ` из ${fmtBytes(disk.imageFsCapacityBytes)} (отдельный диск)`) : ""}
          </span>
        </Hint>
        <Hint label={L("Share of filesystem inodes in use. Running out of inodes fails writes even with free space.", "Доля занятых inodes. Когда они кончаются, запись падает даже при свободном месте.")}>
          <span className={cn(inodesHot && textClass.warn)}>inodes {fmtPct(disk.inodesUsedPct)}</span>
        </Hint>
        {used !== null && used >= 80 ? (
          <Hint label={L("kubelet starts evicting pods when free space falls below its threshold (often 10–15%)", "kubelet начинает выселять поды, когда свободного места меньше порога (обычно 10–15%)")}>
            <span className={textClass.bad}>{L("near eviction threshold", "близко к порогу выселения")}</span>
          </Hint>
        ) : null}
      </div>
    </div>
  );
}

/** PVCs mounted by pods on this node, fullest first. */
function NodeVolumes({ pvcs, onOpen }: { pvcs: Pvc[]; onOpen: () => void }) {
  if (pvcs.length === 0) return null;
  const shown = pvcs.slice(0, 4);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="text-muted-foreground">{L("Volumes (PVC)", "Тома (PVC)")}</span>
        <span className="tabular-nums text-muted-foreground">{pvcs.length}</span>
        <div className="flex-1" />
        <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground hover:underline" onClick={onOpen}>
          {L("Storage →", "Хранилище →")}
        </button>
      </div>
      <ul className="space-y-1">
        {shown.map((p) => {
          const used = pct(p.usedBytes, p.capacityBytes);
          return (
            <li key={`${p.namespace}/${p.name}`} className="flex items-center gap-2 text-[11px]">
              <Hint label={`${p.namespace}/${p.name} · ${p.storageClass ?? "no class"}`}>
                <span className="min-w-0 flex-1 truncate font-mono">{p.name}</span>
              </Hint>
              <UsageBar value={used} className="w-20 shrink-0" />
              <span className={cn("w-9 text-right tabular-nums", textClass[toneForUsage(used)])}>{fmtPct(used)}</span>
              <span className="w-24 text-right tabular-nums text-muted-foreground">
                {fmtBytes(p.usedBytes)} / {fmtBytes(p.capacityBytes)}
              </span>
            </li>
          );
        })}
      </ul>
      {pvcs.length > shown.length ? <div className="text-[11px] text-muted-foreground">{L(`+${pvcs.length - shown.length} more`, `ещё ${pvcs.length - shown.length}`)}</div> : null}
    </div>
  );
}

type SortKey = "name" | "cpu" | "mem" | "cpuReq" | "memReq" | "pods" | "disk";

export function NodesSection({ snapshot }: SectionProps) {
  const metrics = useResource("metrics");
  const storage = useResource("storage");
  const disks = useMemo(() => new Map((storage.data?.nodeDisks ?? []).map((d) => [d.name, d])), [storage.data]);
  const pvcsByNode = useMemo(() => {
    const map = new Map<string, Pvc[]>();
    for (const p of storage.data?.pvcs ?? []) {
      if (!p.node) continue;
      map.set(p.node, [...(map.get(p.node) ?? []), p]);
    }
    for (const list of map.values()) list.sort((a, b) => (pct(b.usedBytes, b.capacityBytes) ?? 0) - (pct(a.usedBytes, a.capacityBytes) ?? 0));
    return map;
  }, [storage.data]);
  const diskPct = (name: string) => {
    const d = disks.get(name);
    return d ? pct(d.usedBytes, d.capacityBytes) : null;
  };
  const m = useMatchers();
  const go = useGo();
  const now = useNow(30_000);
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [expanded, setExpanded] = useState<string | null>(null);

  // Requests come from every pod, regardless of the namespace filter: a node
  // is shared, so its load must include everything scheduled on it.
  const stats = useMemo(() => computeNodeStats(snapshot.nodes, snapshot.pods, metrics.data), [snapshot, metrics.data]);
  const scopeIsPartial = snapshot.selection.namespace !== "*";
  const shown = useMemo(() => {
    const val = (s: NodeStats): number | string => {
      switch (sortKey) {
        case "name":
          return s.node.name;
        case "cpu":
          return pct(s.cpuUsed, s.node.cpuAllocatable) ?? -1;
        case "mem":
          return pct(s.memUsed, s.node.memAllocatable) ?? -1;
        case "cpuReq":
          return pct(s.cpuReq, s.node.cpuAllocatable) ?? -1;
        case "memReq":
          return pct(s.memReq, s.node.memAllocatable) ?? -1;
        case "disk":
          return diskPct(s.node.name) ?? -1;
        default:
          return s.pods.length;
      }
    };
    return stats
      .filter((s) => m.text(`${s.node.name} ${s.node.pool ?? ""} ${s.node.instanceType ?? ""} ${s.node.zone ?? ""}`))
      .sort((a, b) => {
        const va = val(a);
        const vb = val(b);
        return typeof va === "string" ? va.localeCompare(String(vb)) : (vb as number) - va;
      });
  }, [stats, sortKey, m, disks]);

  const totals = {
    cpuAlloc: sum(stats, (s) => s.node.cpuAllocatable),
    memAlloc: sum(stats, (s) => s.node.memAllocatable),
    cpuUsed: metrics.data?.available ? sum(stats, (s) => s.cpuUsed) : null,
    memUsed: metrics.data?.available ? sum(stats, (s) => s.memUsed) : null,
    cpuReq: sum(stats, (s) => s.cpuReq),
    memReq: sum(stats, (s) => s.memReq),
    cpuLim: sum(stats, (s) => s.cpuLim),
    memLim: sum(stats, (s) => s.memLim),
    pods: sum(stats, (s) => s.pods.length),
    podCap: sum(stats, (s) => s.node.podCapacity),
  };
  const ready = stats.filter((s) => s.node.ready).length;
  const diskList = [...disks.values()];
  const diskUsed = diskList.reduce((a, d) => a + (d.usedBytes ?? 0), 0);
  const diskCap = diskList.reduce((a, d) => a + (d.capacityBytes ?? 0), 0);
  const fullestDisk = [...diskList].sort((a, b) => (pct(b.usedBytes, b.capacityBytes) ?? 0) - (pct(a.usedBytes, a.capacityBytes) ?? 0))[0];

  const pools = useMemo(() => {
    const map = new Map<string, NodeStats[]>();
    for (const s of stats) {
      const key = s.node.pool ?? s.node.instanceType ?? "default";
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map.entries()].map(([name, list]) => ({
      name,
      nodes: list.length,
      ready: list.filter((s) => s.node.ready).length,
      instanceType: [...new Set(list.map((s) => s.node.instanceType).filter(Boolean))].join(", "),
      cpu: pct(sum(list, (s) => s.cpuUsed), sum(list, (s) => s.node.cpuAllocatable)),
      cpuReq: pct(sum(list, (s) => s.cpuReq), sum(list, (s) => s.node.cpuAllocatable)),
      mem: pct(sum(list, (s) => s.memUsed), sum(list, (s) => s.node.memAllocatable)),
      memReq: pct(sum(list, (s) => s.memReq), sum(list, (s) => s.node.memAllocatable)),
      pods: sum(list, (s) => s.pods.length),
      podCap: sum(list, (s) => s.node.podCapacity),
      disk: pct(sum(list, (s) => disks.get(s.node.name)?.usedBytes ?? null), sum(list, (s) => disks.get(s.node.name)?.capacityBytes ?? null)),
    }));
  }, [stats, disks]);

  const podUsage = useMemo(() => {
    const map = new Map<string, { cpu: number; mem: number }>();
    for (const p of metrics.data?.pods ?? []) map.set(`${p.namespace}/${p.name}`, p);
    return map;
  }, [metrics.data]);

  const showPodsOnNode = (name: string) => {
    filters.update({ node: name });
    go("pods");
  };

  return (
    <>
      {metrics.data && !metrics.data.available ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {L("metrics-server is not answering, so real usage is missing; requests and limits are still shown.", "metrics-server не отвечает, поэтому реальной загрузки нет; запросы и лимиты показаны.")} {metrics.data.error}
        </p>
      ) : null}
      {scopeIsPartial ? (
        <p className="text-xs text-muted-foreground">
          {L("Requests below count only pods in the selected namespace. Pick “All namespaces” for the full node load.", "Запросы ниже считаются только по подам выбранного неймспейса. Выберите «Все неймспейсы», чтобы увидеть полную нагрузку нод.")}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
        <Metric
          label={L("Nodes ready", "Ноды готовы")}
          value={`${ready}/${stats.length}`}
          tone={ready < stats.length ? "bad" : "good"}
          note={L(`${stats.filter((s) => s.node.unschedulable).length} cordoned`, `в cordon: ${stats.filter((s) => s.node.unschedulable).length}`)}
        />
        <Metric
          label={L("CPU used", "CPU занято")}
          value={fmtPct(pct(totals.cpuUsed, totals.cpuAlloc))}
          tone={toneForUsage(pct(totals.cpuUsed, totals.cpuAlloc))}
          note={L(`${fmtCpu(totals.cpuUsed)} of ${fmtCpu(totals.cpuAlloc)} cores · requested ${fmtPct(pct(totals.cpuReq, totals.cpuAlloc))}`, `${fmtCpu(totals.cpuUsed)} из ${fmtCpu(totals.cpuAlloc)} · запр. ${fmtPct(pct(totals.cpuReq, totals.cpuAlloc))}`)}
        >
          <UsageBar className="mt-2" value={pct(totals.cpuUsed, totals.cpuAlloc)} marker={pct(totals.cpuReq, totals.cpuAlloc)} />
        </Metric>
        <Metric
          label={L("Memory used", "Память занята")}
          value={fmtPct(pct(totals.memUsed, totals.memAlloc))}
          tone={toneForUsage(pct(totals.memUsed, totals.memAlloc))}
          note={L(`${fmtBytes(totals.memUsed)} of ${fmtBytes(totals.memAlloc)} · requested ${fmtPct(pct(totals.memReq, totals.memAlloc))}`, `${fmtBytes(totals.memUsed)} из ${fmtBytes(totals.memAlloc)} · запр. ${fmtPct(pct(totals.memReq, totals.memAlloc))}`)}
        >
          <UsageBar className="mt-2" value={pct(totals.memUsed, totals.memAlloc)} marker={pct(totals.memReq, totals.memAlloc)} />
        </Metric>
        <Metric
          label={L("Pods scheduled", "Подов размещено")}
          value={`${totals.pods}/${totals.podCap}`}
          tone={toneForUsage(pct(totals.pods, totals.podCap))}
          note={L(`limits: CPU ${fmtPct(pct(totals.cpuLim, totals.cpuAlloc))}, mem ${fmtPct(pct(totals.memLim, totals.memAlloc))}`, `лимиты: CPU ${fmtPct(pct(totals.cpuLim, totals.cpuAlloc))}, пам. ${fmtPct(pct(totals.memLim, totals.memAlloc))}`)}
        >
          <UsageBar className="mt-2" value={pct(totals.pods, totals.podCap)} />
        </Metric>
        <Metric
          label={L("Disk used", "Диск занят")}
          value={storage.data ? fmtPct(pct(diskUsed, diskCap)) : "—"}
          tone={fullestDisk ? toneForUsage(pct(fullestDisk.usedBytes, fullestDisk.capacityBytes)) : undefined}
          note={
            fullestDisk
              ? L(`fullest ${fullestDisk.name.split("-").at(-1)} ${fmtPct(pct(fullestDisk.usedBytes, fullestDisk.capacityBytes))} · ${fmtBytes(diskUsed)} of ${fmtBytes(diskCap)}`, `макс. ${fullestDisk.name.split("-").at(-1)} ${fmtPct(pct(fullestDisk.usedBytes, fullestDisk.capacityBytes))} · ${fmtBytes(diskUsed)}`)
              : storage.data
                ? L("needs nodes/proxy access", "нужен доступ к nodes/proxy")
                : L("loading…", "загрузка…")
          }
        >
          <UsageBar className="mt-2" value={pct(diskUsed, diskCap)} marker={fullestDisk ? pct(fullestDisk.usedBytes, fullestDisk.capacityBytes) : null} />
        </Metric>
      </div>

      {pools.length > 1 ? (
        <SectionCard title={L(`Node pools (${pools.length})`, `Пулы нод (${pools.length})`)}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <th className={th}>{L("Pool", "Пул")}</th>
                  <th className={th}>{L("Nodes", "Ноды")}</th>
                  <th className={th}>{L("CPU used / requested", "CPU занято / запрошено")}</th>
                  <th className={th}>{L("Memory used / requested", "Память занята / запрошена")}</th>
                  <th className={th}>{L("Disk", "Диск")}</th>
                  <th className={cn(th, "text-right")}>{L("Pods", "Поды")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pools.map((p) => (
                  <tr key={p.name}>
                    <td className={cn(td, "max-w-[260px]")}>
                      <div className="truncate font-mono text-xs">{p.name}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{p.instanceType}</div>
                    </td>
                    <td className={cn(td, "text-xs tabular-nums", p.ready < p.nodes && textClass.bad)}>
                      {p.ready}/{p.nodes}
                    </td>
                    <td className={cn(td, "w-[24%]")}>
                      <div className="flex items-center gap-2 text-xs tabular-nums">
                        <UsageBar value={p.cpu} marker={p.cpuReq} />
                        <span className="w-20 shrink-0">{fmtPct(p.cpu)} / {fmtPct(p.cpuReq)}</span>
                      </div>
                    </td>
                    <td className={cn(td, "w-[24%]")}>
                      <div className="flex items-center gap-2 text-xs tabular-nums">
                        <UsageBar value={p.mem} marker={p.memReq} />
                        <span className="w-20 shrink-0">{fmtPct(p.mem)} / {fmtPct(p.memReq)}</span>
                      </div>
                    </td>
                    <td className={cn(td, "w-[14%]")}>
                      <div className="flex items-center gap-2 text-xs tabular-nums">
                        <UsageBar value={p.disk} />
                        <span className="w-10 shrink-0">{fmtPct(p.disk)}</span>
                      </div>
                    </td>
                    <td className={cn(td, "text-right text-xs tabular-nums")}>
                      {p.pods}/{p.podCap}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{L("Sort nodes by", "Сортировать по")}</span>
        <NativeSelect
          className="w-48"
          label={L("Sort nodes by", "Сортировать ноды по")}
          value={sortKey}
          onChange={(v) => setSortKey(v as SortKey)}
          options={[
            { value: "cpu", label: L("CPU usage", "загрузке CPU") },
            { value: "mem", label: L("Memory usage", "загрузке памяти") },
            { value: "cpuReq", label: L("CPU requested", "запросам CPU") },
            { value: "memReq", label: L("Memory requested", "запросам памяти") },
            { value: "disk", label: L("Disk usage", "заполнению диска") },
            { value: "pods", label: L("Pod count", "числу подов") },
            { value: "name", label: L("Name", "имени") },
          ]}
        />
        <span className="text-xs text-muted-foreground">{L("Bar = real usage, tick = requests. Disk = root filesystem of the node.", "Полоса — реальная загрузка, риска — запросы. Диск — корневая файловая система ноды.")}</span>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        {shown.map((s) => {
          const n = s.node;
          const open = expanded === n.name;
          const topPods = [...s.pods]
            .map((p) => ({ p, u: podUsage.get(`${p.namespace}/${p.name}`) }))
            .sort((a, b) => (b.u?.cpu ?? b.p.cpuRequest) - (a.u?.cpu ?? a.p.cpuRequest))
            .slice(0, 8);
          // CPU over-limit only throttles; memory over-limit can OOM-kill pods.
          const overcommit = s.memLim > n.memAllocatable * 1.2;
          return (
            <section key={n.name} className="space-y-3 rounded-lg border border-border bg-card p-3">
              <header className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs font-medium" title={n.name}>
                    {n.name}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <StatusPill tone={nodeTone(s)}>{n.ready ? L("Ready", "Готова") : L("NotReady", "Не готова")}</StatusPill>
                    {n.unschedulable ? <Chip tone="warn">cordon</Chip> : null}
                    {n.pressure.map((p) => (
                      <Chip key={p} tone="bad">
                        {p}
                      </Chip>
                    ))}
                    {overcommit ? (
                      <Chip tone="warn" title={L("Sum of memory limits is above 120% of allocatable: under load the kernel OOM-kills pods", "Сумма лимитов памяти больше 120% доступной: под нагрузкой ядро будет убивать поды (OOM)")}>
                        {L("memory overcommitted", "память переподписана")}
                      </Chip>
                    ) : null}
                    {n.pool ? <Chip>{n.pool}</Chip> : null}
                    {n.instanceType ? <Chip>{n.instanceType}</Chip> : null}
                    {n.zone ? <Chip>{n.zone}</Chip> : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <ActionButton icon="Box" label={L(`Pods ${s.pods.length}`, `Поды ${s.pods.length}`)} hint={L("Show the pods running on this node", "Показать поды на этой ноде")} onClick={() => showPodsOnNode(n.name)} />
                  <IconButton icon="FileText" label={L("Describe", "Описание")} hint={L("Describe: full kubectl describe output (spec, status, events)", "Описание: полный вывод kubectl describe (spec, status, события)")} onClick={() => actions.describe("node", "", n.name)} />
                </div>
              </header>
              <UsageRow label="CPU" used={s.cpuUsed} requested={s.cpuReq} total={n.cpuAllocatable} fmt={fmtCpu} />
              <UsageRow label={L("Memory", "Память")} used={s.memUsed} requested={s.memReq} total={n.memAllocatable} fmt={fmtBytes} />
              <DiskRow disk={disks.get(n.name) ?? null} loading={!storage.data} />
              <NodeVolumes pvcs={pvcsByNode.get(n.name) ?? []} onOpen={() => go("storage")} />
              <div className="space-y-1">
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="w-14 shrink-0 text-muted-foreground">{L("Pods", "Поды")}</span>
                  <span className="tabular-nums">
                    {s.pods.length}/{n.podCapacity}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
                    {L("limits CPU", "лимиты CPU")} {fmtPct(pct(s.cpuLim, n.cpuAllocatable))} {L("· mem", "· память")} {fmtPct(pct(s.memLim, n.memAllocatable))}
                  </span>
                </div>
                <UsageBar value={pct(s.pods.length, n.podCapacity)} />
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                <span>{n.version}</span>
                {n.internalIP ? <span className="font-mono">{n.internalIP}</span> : null}
                <span>{L("age", "возраст")} {ago(n.createdAt, now)}</span>
                {n.taints.length ? <span title={n.taints.join("\n")}>taints: {n.taints.length}</span> : null}
                <span className="truncate" title={`${n.osImage} · ${n.kernel} · ${n.runtime}`}>
                  {n.runtime}
                </span>
              </div>
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={open}
                onClick={() => setExpanded(open ? null : n.name)}
              >
                <Icon name="kube-ChevronRight" className={cn("size-3.5 transition-transform", open && "rotate-90")} />
                {L("Top pods by CPU and disk", "Топ подов по CPU и диску")}
              </button>
              {open ? (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {topPods.map(({ p, u }) => (
                    <li key={`${p.namespace}/${p.name}`} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                      <span className="min-w-0 flex-1 truncate font-mono" title={`${p.namespace}/${p.name}`}>
                        {p.name}
                        <span className="ml-1 text-muted-foreground">{p.namespace}</span>
                      </span>
                      <span className="w-24 text-right tabular-nums" title={L("usage / request", "занято / запрошено")}>
                        {fmtCpu(u?.cpu)} / {fmtCpu(p.cpuRequest)}
                      </span>
                      <span className="w-24 text-right tabular-nums" title={L("usage / request", "занято / запрошено")}>
                        {fmtBytes(u?.mem)} / {fmtBytes(p.memRequest)}
                      </span>
                      <IconButton icon="ScrollText" label={L("Logs", "Логи")} hint={L("Show this pod's logs", "Показать логи пода")} onClick={() => actions.podLogs(p)} />
                    </li>
                  ))}
                  {topPods.length === 0 ? <li className="px-2 py-1.5 text-xs text-muted-foreground">{L("No pods.", "Подов нет.")}</li> : null}
                </ul>
              ) : null}
              {open && (disks.get(n.name)?.topEphemeral.length ?? 0) > 0 ? (
                <div className="space-y-1">
                  <Hint label={L("Ephemeral storage: container logs, emptyDir volumes and writable layers on the node's own disk", "Ephemeral storage: логи контейнеров, тома emptyDir и записываемые слои на диске самой ноды")}>
                    <div className="w-fit text-xs text-muted-foreground">{L("Writing most to the node disk", "Больше всего пишут на диск ноды")}</div>
                  </Hint>
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {disks.get(n.name)!.topEphemeral.map((e) => (
                      <li key={`${e.namespace}/${e.name}`} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                        <span className="min-w-0 flex-1 truncate font-mono" title={`${e.namespace}/${e.name}`}>
                          {e.name}
                          <span className="ml-1 text-muted-foreground">{e.namespace}</span>
                        </span>
                        <span className="w-20 text-right tabular-nums">{fmtBytes(e.usedBytes)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </>
  );
}
