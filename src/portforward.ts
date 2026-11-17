// Long-running `kubectl port-forward` processes owned by the bb server.
// They bind 127.0.0.1 only and die with the plugin (reload, disable, quit).
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { PortForward } from "./contract";

const MAX_FORWARDS = 30;
const KEEP_STOPPED = 10;

interface Entry {
  info: PortForward;
  child: ChildProcess | null;
}

export interface StartInput {
  context: string;
  namespace: string;
  kind: PortForward["kind"];
  name: string;
  remotePort: number;
  localPort?: number;
}

export function createPortForwards(options: {
  kubectlBin: string;
  env: NodeJS.ProcessEnv;
  onChange: () => void;
  log: (message: string) => void;
}) {
  const entries = new Map<string, Entry>();

  function list(): PortForward[] {
    return [...entries.values()]
      .map((e) => e.info)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  function prune() {
    const stopped = [...entries.values()].filter(
      (e) => e.info.status === "stopped" || e.info.status === "error",
    );
    for (const e of stopped.slice(0, Math.max(0, stopped.length - KEEP_STOPPED))) {
      entries.delete(e.info.id);
    }
  }

  function start(input: StartInput): Promise<PortForward> {
    const active = [...entries.values()].filter(
      (e) => e.info.status === "running" || e.info.status === "starting",
    );
    if (active.length >= MAX_FORWARDS) {
      return Promise.reject(new Error(`At most ${MAX_FORWARDS} port-forwards can run at once.`));
    }
    const duplicate = active.find(
      (e) =>
        e.info.context === input.context &&
        e.info.namespace === input.namespace &&
        e.info.kind === input.kind &&
        e.info.name === input.name &&
        e.info.remotePort === input.remotePort &&
        (input.localPort === undefined || input.localPort === 0 || e.info.localPort === input.localPort),
    );
    if (duplicate) return Promise.resolve(duplicate.info);

    const id = randomUUID().slice(0, 8);
    const info: PortForward = {
      id,
      context: input.context,
      namespace: input.namespace,
      kind: input.kind,
      name: input.name,
      remotePort: input.remotePort,
      localPort: input.localPort ? input.localPort : null,
      status: "starting",
      error: null,
      startedAt: new Date().toISOString(),
      connections: 0,
    };
    const local = input.localPort ? String(input.localPort) : "";
    const child = spawn(
      options.kubectlBin,
      [
        "--context", input.context,
        "-n", input.namespace,
        "port-forward",
        "--address", "127.0.0.1",
        `${input.kind}/${input.name}`,
        `${local}:${input.remotePort}`,
      ],
      { env: options.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const entry: Entry = { info, child };
    entries.set(id, entry);
    prune();
    options.log(`port-forward ${id} ${input.context}/${input.namespace} ${input.kind}/${input.name} ${local || "auto"}:${input.remotePort}`);

    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve({ ...entry.info });
      };
      const timeout = setTimeout(() => {
        if (entry.info.status === "starting") {
          entry.info.status = "error";
          entry.info.error = "kubectl port-forward did not start within 20s";
          child.kill();
        }
        settle();
      }, 20_000);

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) {
          const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(line);
          if (m) {
            entry.info.localPort = Number(m[1]);
            entry.info.status = "running";
            clearTimeout(timeout);
            options.onChange();
            settle();
          } else if (line.startsWith("Handling connection")) {
            entry.info.connections += 1;
          }
        }
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-2000);
        const last = chunk.trim().split("\n").at(-1);
        // Per-connection errors keep the forward alive; remember the last one.
        if (last && entry.info.status === "running") entry.info.error = last.slice(0, 300);
      });
      child.on("error", (error) => {
        entry.info.status = "error";
        entry.info.error = error.message;
        entry.child = null;
        clearTimeout(timeout);
        options.onChange();
        settle();
      });
      child.on("exit", (code, signal) => {
        entry.child = null;
        clearTimeout(timeout);
        if (entry.info.status !== "stopped") {
          entry.info.status = code === 0 || signal === "SIGTERM" ? "stopped" : "error";
          const detail = stderr.trim().split("\n").slice(-3).join("\n");
          if (entry.info.status === "error") entry.info.error = detail || `kubectl exited with ${code}`;
        }
        options.onChange();
        settle();
      });
    });
  }

  function stop(id: string): boolean {
    const entry = entries.get(id);
    if (!entry) return false;
    if (entry.child) {
      entry.info.status = "stopped";
      entry.child.kill("SIGTERM");
    } else {
      entries.delete(id);
    }
    options.onChange();
    return true;
  }

  function disposeAll() {
    for (const entry of entries.values()) {
      entry.info.status = "stopped";
      entry.child?.kill("SIGTERM");
    }
    entries.clear();
  }

  return { list, start, stop, disposeAll };
}
