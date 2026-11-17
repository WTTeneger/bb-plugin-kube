// PVC analytics: how full each volume is, what uses it, per-class totals and
// volumes that cost money but nothing mounts.
import { useMemo, useState } from "react";
import type { Pod, Pvc } from "../../contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { actions } from "../dialogs";
import {
  ago,
  Chip,
  EmptyState,
  ErrorBox,
  FilterBar,
  fmtBytes,
  fmtPct,
  IconButton,
  Metric,
  NameCell,
  pct,
  SectionCard,
  StatusPill,
  td,
  textClass,
  th,
  Toggle,
  toneForUsage,
  UsageBar,
  useGo,
  useNow,
  type Tone,
} from "../shared";
import { filters, useMatchers, useResource } from "../store";
import type { SectionProps } from "./workloads";
import { L } from "../i18n";

type View = "all" | "full" | "unbound" | "unused";

function pvcTone(p: Pvc): Tone {
  if (p.status === "Lost") return "bad";
  if (p.status === "Pending") return "warn";
  return "good";
}

export function usedPct(p: Pvc): number | null {
  return pct(p.usedBytes, p.capacityBytes);
}

export function StorageSection({ snapshot }: SectionProps) {
  const storage = useResource("storage");
  const m = useMatchers();
  const go = useGo();
  const now = useNow(30_000);
  const [view, setView] = useState<View>("all");

  const mounts = useMemo(() => {
    const map = new Map<string, Pod[]>();
    for (const p of snapshot.pods) {
      if (p.terminated) continue;
      for (const claim of p.pvcs) {
        const key = `${p.namespace}/${claim}`;
        map.set(key, [...(map.get(key) ?? []), p]);
      }
    }
    return map;
  }, [snapshot.pods]);

  if (!storage.data) {
    return storage.error ? (
      <ErrorBox title={L("Can't read storage", "Не удалось прочитать хранилище")} error={storage.error} onRetry={storage.reload} />
    ) : (
      <EmptyState>{L("Loading volumes and their usage…", "Загрузка томов и их заполненности…")}</EmptyState>
    );
  }
  const data = storage.data;
  const pvcs = data.pvcs.filter((p) => m.ns(p.namespace));
  const unused = pvcs.filter((p) => p.status === "Bound" && !(mounts.get(`${p.namespace}/${p.name}`)?.length));
  const full = pvcs.filter((p) => (usedPct(p) ?? 0) >= 80);
  const unbound = pvcs.filter((p) => p.status !== "Bound");
  const totalCap = pvcs.reduce((a, p) => a + (p.capacityBytes ?? p.requestBytes ?? 0), 0);
  const measured = pvcs.filter((p) => p.usedBytes !== null);
  const totalUsed = measured.reduce((a, p) => a + (p.usedBytes ?? 0), 0);
  const measuredCap = measured.reduce((a, p) => a + (p.capacityBytes ?? 0), 0);

  const rows = (view === "full" ? full : view === "unbound" ? unbound : view === "unused" ? unused : pvcs)
    .filter((p) => m.text(`${p.namespace}/${p.name} ${p.storageClass ?? ""} ${p.volume ?? ""}`))
    .sort((a, b) => (usedPct(b) ?? -1) - (usedPct(a) ?? -1) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));

  const classes = data.storageClasses.map((sc) => {
    const list = pvcs.filter((p) => p.storageClass === sc.name);
    const cap = list.reduce((a, p) => a + (p.capacityBytes ?? p.requestBytes ?? 0), 0);
    const meas = list.filter((p) => p.usedBytes !== null);
    return {
      sc,
      count: list.length,
      cap,
      used: meas.reduce((a, p) => a + (p.usedBytes ?? 0), 0),
      usedPct: pct(meas.reduce((a, p) => a + (p.usedBytes ?? 0), 0), meas.reduce((a, p) => a + (p.capacityBytes ?? 0), 0)),
    };
  });
  const orphanPvs = data.pvs.filter((pv) => pv.status === "Released" || pv.status === "Failed" || pv.status === "Available");

  return (
    <>
      {!data.usageAvailable ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {L("Volume fill levels need read access to", "Для заполненности томов нужен доступ на чтение к")} <code>nodes/proxy</code> {L("(kubelet stats); only sizes are shown.", "(статистика kubelet); показаны только размеры.")}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="PVCs"
          value={pvcs.length}
          note={L(`${pvcs.filter((p) => p.status === "Bound").length} bound · ${unbound.length} not bound`, `привязано: ${pvcs.filter((p) => p.status === "Bound").length} · не привязано: ${unbound.length}`)}
          tone={unbound.length ? "warn" : "good"}
          onClick={() => setView(unbound.length ? "unbound" : "all")}
        />
        <Metric
          label={L("Used (mounted volumes)", "Занято (смонтированные тома)")}
          value={fmtPct(pct(totalUsed, measuredCap))}
          tone={toneForUsage(pct(totalUsed, measuredCap))}
          note={L(`${fmtBytes(totalUsed)} of ${fmtBytes(measuredCap)} · ${fmtBytes(totalCap)} provisioned`, `${fmtBytes(totalUsed)} из ${fmtBytes(measuredCap)} · выделено ${fmtBytes(totalCap)}`)}
        >
          <UsageBar className="mt-2" value={pct(totalUsed, measuredCap)} />
        </Metric>
        <Metric
          label={L("≥ 80% full", "Заполнены ≥ 80%")}
          value={full.length}
          tone={full.some((p) => (usedPct(p) ?? 0) >= 90) ? "bad" : full.length ? "warn" : "good"}
          note={full[0] ? `${L("fullest", "больше всего")}: ${[...full].sort((a, b) => (usedPct(b) ?? 0) - (usedPct(a) ?? 0))[0]!.name}` : L("none", "нет")}
          onClick={() => setView("full")}
        />
        <Metric
          label={L("Bound, not mounted", "Привязаны, но не смонтированы")}
          value={unused.length}
          tone={unused.length ? "warn" : "good"}
          note={L(`${fmtBytes(unused.reduce((a, p) => a + (p.capacityBytes ?? 0), 0))} idle · ${orphanPvs.length} unclaimed PVs`, `простаивает ${fmtBytes(unused.reduce((a, p) => a + (p.capacityBytes ?? 0), 0))} · PV без заявки: ${orphanPvs.length}`)}
          onClick={() => setView("unused")}
        />
      </div>

      <FilterBar count={rows.length} total={pvcs.length}>
        {(
          [
            ["all", L("All", "Все")],
            ["full", `≥80% ${full.length}`],
            ["unbound", L(`Not bound ${unbound.length}`, `Не привязаны ${unbound.length}`)],
            ["unused", L(`Not mounted ${unused.length}`, `Не смонтированы ${unused.length}`)],
          ] as const
        ).map(([v, label]) => (
          <Toggle key={v} value={view === v} onChange={() => setView(v)}>
            {label}
          </Toggle>
        ))}
      </FilterBar>

      <SectionCard
        title={L("Persistent volume claims", "Заявки на тома (PVC)")}
        action={
          <IconButton icon="RefreshCw" label={L("Reload usage", "Обновить заполненность")} hint={L("Re-read volume usage from every node now", "Заново прочитать заполненность томов со всех нод")} onClick={storage.reload} />
        }
      >
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{L("No PVCs match.", "Подходящих PVC нет.")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <th className={th}>PVC</th>
                  <th className={th}>{L("Status", "Статус")}</th>
                  <th className={cn(th, "min-w-[200px]")}>{L("Used", "Занято")}</th>
                  <th className={th}>{L("Class", "Класс")}</th>
                  <th className={th}>{L("Mounted by", "Кто монтирует")}</th>
                  <th className={cn(th, "text-right")}>{L("Age", "Возраст")}</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((p) => {
                  const used = usedPct(p);
                  const users = mounts.get(`${p.namespace}/${p.name}`) ?? [];
                  return (
                    <tr key={`${p.namespace}/${p.name}`} className="hover:bg-state-hover/50">
                      <NameCell name={p.name} sub={`${p.namespace} · ${p.accessModes.join(",")}${p.volumeMode === "Block" ? L(" · block", " · блочный") : ""}`} />
                      <td className={td}>
                        <StatusPill tone={pvcTone(p)}>{p.status}</StatusPill>
                        {p.resizing ? <div className="mt-0.5"><Chip tone="info">{L("resizing", "меняет размер")}</Chip></div> : null}
                      </td>
                      <td className={td}>
                        <div className="flex items-center gap-2">
                          <UsageBar value={used} className="w-24" />
                          <span className={cn("w-10 text-right text-xs tabular-nums", textClass[toneForUsage(used)])}>{fmtPct(used)}</span>
                        </div>
                        <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                          {p.usedBytes !== null ? L(`${fmtBytes(p.usedBytes)} of `, `${fmtBytes(p.usedBytes)} из `) : ""}
                          {fmtBytes(p.capacityBytes ?? p.requestBytes)}
                          {p.inodesUsedPct !== null && p.inodesUsedPct >= 80 ? (
                            <span className={textClass.warn}> · inodes {fmtPct(p.inodesUsedPct)}</span>
                          ) : null}
                        </div>
                      </td>
                      <td className={cn(td, "text-xs text-muted-foreground")}>{p.storageClass ?? "—"}</td>
                      <td className={cn(td, "max-w-[220px] text-xs")}>
                        {users.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <button
                            type="button"
                            className="max-w-full truncate text-left font-mono hover:underline"
                            title={users.map((u) => u.name).join("\n")}
                            onClick={() => {
                              const w = users[0]!.workload;
                              if (w) filters.update({ workload: { namespace: p.namespace, kind: w.kind, name: w.name } });
                              else filters.update({ query: users[0]!.name });
                              go("pods");
                            }}
                          >
                            {users[0]!.workload?.name ?? users[0]!.name}
                            {users.length > 1 ? ` +${users.length - 1}` : ""}
                          </button>
                        )}
                      </td>
                      <td className={cn(td, "text-right text-xs tabular-nums text-muted-foreground")}>{ago(p.createdAt, now)}</td>
                      <td className={cn(td, "text-right")}>
                        <IconButton icon="FileText" label={L("Describe", "Описание")} hint={L("Describe: full kubectl describe output (spec, status, events)", "Описание: полный вывод kubectl describe (spec, status, события)")} onClick={() => actions.describe("persistentvolumeclaim", p.namespace, p.name)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard title={L(`Storage classes (${classes.length})`, `Классы хранения (${classes.length})`)}>
          <ul className="divide-y divide-border">
            {classes.map(({ sc, count, cap, used, usedPct: up }) => (
              <li key={sc.name} className="space-y-1 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {sc.name}
                    {sc.isDefault ? <span className="ml-1 text-muted-foreground">{L("(default)", "(по умолчанию)")}</span> : null}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    PVC: {count} · {fmtBytes(cap)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <UsageBar value={up} />
                  <span className="w-28 shrink-0 text-right tabular-nums text-muted-foreground">
                    {L(`${fmtBytes(used)} used (${fmtPct(up)})`, `занято ${fmtBytes(used)} (${fmtPct(up)})`)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1 text-muted-foreground">
                  <Chip>{sc.provisioner}</Chip>
                  {sc.reclaimPolicy ? <Chip tone={sc.reclaimPolicy === "Delete" ? "muted" : "info"}>{L("reclaim", "после удаления:")} {sc.reclaimPolicy}</Chip> : null}
                  <Chip tone={sc.allowExpansion ? "good" : "muted"}>{sc.allowExpansion ? L("expandable", "можно расширять") : L("fixed size", "фиксированный размер")}</Chip>
                  {sc.bindingMode ? <Chip>{sc.bindingMode}</Chip> : null}
                </div>
              </li>
            ))}
            {classes.length === 0 ? <li className="px-3 py-4 text-sm text-muted-foreground">{L("No storage classes.", "Классов хранения нет.")}</li> : null}
          </ul>
        </SectionCard>
        <SectionCard title={L(`Unclaimed persistent volumes (${orphanPvs.length})`, `Тома без заявки (${orphanPvs.length})`)}>
          {orphanPvs.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">{L("Every PV is bound to a claim.", "Все PV привязаны к заявкам.")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {orphanPvs.map((pv) => (
                <li key={pv.name} className="flex items-center gap-2 px-3 py-2 text-xs">
                  <StatusPill tone={pv.status === "Failed" ? "bad" : "warn"}>{pv.status}</StatusPill>
                  <span className="min-w-0 flex-1 truncate font-mono" title={pv.claim ? `was ${pv.claim}` : undefined}>
                    {pv.name}
                    {pv.claim ? <span className="ml-1 text-muted-foreground">{L("was", "был")} {pv.claim}</span> : null}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{fmtBytes(pv.capacityBytes)}</span>
                  <span className="tabular-nums text-muted-foreground">{ago(pv.createdAt, now)}</span>
                  <IconButton icon="FileText" label={L("Describe", "Описание")} hint={L("Describe: full kubectl describe output (spec, status, events)", "Описание: полный вывод kubectl describe (spec, status, события)")} onClick={() => actions.describe("persistentvolume", "", pv.name)} />
                </li>
              ))}
            </ul>
          )}
          {orphanPvs.some((pv) => pv.reclaimPolicy === "Retain") ? (
            <p className="flex items-center gap-1 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              <Icon name="kube-Database" className="size-3" />
              {L("Retained volumes keep their disk (and cost) until deleted by hand.", "Тома с политикой Retain хранят диск (и стоят денег), пока их не удалят вручную.")}
            </p>
          ) : null}
        </SectionCard>
      </div>
      {data.errors.length ? (
        <details className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">{data.errors.length} storage reads failed</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono">
            {data.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
