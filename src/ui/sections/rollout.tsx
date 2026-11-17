// "Rollout check": the same live card agents put in chat, built by hand.
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { RolloutCard } from "../rollout-block";
import type { BlockSpec } from "../rollout-parse";
import { Hint, NativeSelect, SectionCard } from "../shared";
import { useMatchers } from "../store";
import type { SectionProps } from "./workloads";
import { L } from "../i18n";

function localInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function RolloutSection({ snapshot }: SectionProps) {
  const m = useMatchers();
  const namespaces = useMemo(
    () => [...new Set(snapshot.workloads.map((w) => w.namespace))].filter((n) => m.ns(n)).sort(),
    [snapshot.workloads, m.ns, m.text, m.filters],
  );
  const [namespace, setNamespace] = useState(namespaces[0] ?? "");
  const ns = namespaces.includes(namespace) ? namespace : (namespaces[0] ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  const [since, setSince] = useState(() => localInput(new Date(Date.now() - 60 * 60_000)));
  const [useSince, setUseSince] = useState(true);
  const [spec, setSpec] = useState<BlockSpec | null>(null);

  const candidates = snapshot.workloads.filter((w) => w.namespace === ns && m.text(w.name));
  const key = (w: { kind: string; name: string }) => `${w.kind}/${w.name}`;
  const toggle = (k: string) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  const build = (): BlockSpec => ({
    context: snapshot.selection.context,
    namespace: ns,
    since: useSince && since ? new Date(since).toISOString() : null,
    title: null,
    workloads: candidates
      .filter((w) => picked.includes(key(w)))
      .map((w) => ({ kind: w.kind, name: w.name })),
  });
  const blockText = (s: BlockSpec) =>
    [
      "```kube-rollout",
      `context: ${s.context}`,
      `namespace: ${s.namespace}`,
      ...(s.since ? [`since: ${s.since}`] : []),
      ...(s.workloads.length ? [`workloads: ${s.workloads.map((w) => `${w.kind.toLowerCase()}/${w.name}`).join(", ")}`] : []),
      "```",
    ].join("\n");

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {L(
          "Check whether workloads were restarted after a given time. Agents show the same card in chat when they write a",
          "Проверка, перезапустились ли ворклоады после заданного времени. Агенты показывают такую же карточку в чате, когда пишут блок",
        )}{" "}
        <code>kube-rollout</code>{L(" block.", ".")}
      </p>
      <SectionCard title={L("What to check", "Что проверить")}>
        <div className="space-y-3 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-xs text-muted-foreground">{L("Namespace", "Неймспейс")}</span>
            <NativeSelect
              className="w-64"
              label={L("Namespace", "Неймспейс")}
              value={ns}
              onChange={(v) => {
                setNamespace(v);
                setPicked([]);
              }}
              options={namespaces.map((n) => ({ value: n, label: n }))}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-xs text-muted-foreground">{L("Started at", "Начало")}</span>
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={useSince} onChange={(e) => setUseSince(e.target.checked)} />
              {L("compare pods with", "сравнить поды со временем")}
            </label>
            <Input
              type="datetime-local"
              value={since}
              disabled={!useSince}
              onChange={(e) => setSince(e.target.value)}
              className="h-8 w-56 text-xs"
              aria-label={L("Rollout start time", "Время начала выката")}
            />
            {[15, 60, 180].map((min) => (
              <Button key={min} variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => { setUseSince(true); setSince(localInput(new Date(Date.now() - min * 60_000))); }}>
                −{min < 60 ? L(`${min}m`, `${min} мин`) : L(`${min / 60}h`, `${min / 60} ч`)}
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            <span className="w-24 shrink-0 pt-1 text-xs text-muted-foreground">{L("Workloads", "Ворклоады")}</span>
            <div className="flex flex-1 flex-wrap gap-1.5">
              {candidates.map((w) => (
                <Hint key={key(w)} label={L(`${w.kind} · ${w.ready}/${w.desired} ready`, `${w.kind} · готово ${w.ready}/${w.desired}`)}>
                  <button
                    type="button"
                    aria-pressed={picked.includes(key(w))}
                    onClick={() => toggle(key(w))}
                    className={cn(
                      "rounded-md border border-border px-2 py-0.5 font-mono text-xs hover:bg-state-hover",
                      picked.includes(key(w)) && "border-foreground/40 bg-state-active",
                    )}
                  >
                    {w.name}
                  </button>
                </Hint>
              ))}
              {candidates.length === 0 ? <span className="text-xs text-muted-foreground">{L("No workloads.", "Ворклоадов нет.")}</span> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pl-[104px]">
            <Button size="sm" disabled={!ns} onClick={() => setSpec(build())}>
              <Icon name="kube-Check" className="size-3.5" />
              {picked.length ? L(`Check ${picked.length} workloads`, `Проверить выбранные (${picked.length})`) : L("Check the whole namespace", "Проверить весь неймспейс")}
            </Button>
            {spec ? (
              <Hint label={L("Copy as a kube-rollout block to paste into a chat", "Скопировать как блок kube-rollout, чтобы вставить в чат")}>
                <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(blockText(spec))}>
                  <Icon name="kube-Copy" className="size-3.5" />
                  {L("Copy block", "Копировать блок")}
                </Button>
              </Hint>
            ) : null}
          </div>
        </div>
      </SectionCard>
      {spec ? <RolloutCard key={JSON.stringify(spec)} spec={spec} /> : null}
    </>
  );
}
