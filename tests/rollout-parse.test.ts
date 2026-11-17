// Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlock } from "../src/ui/rollout-parse.ts";

test("key: value form with kinds and a bare name", () => {
  const r = parseBlock(`context: my-cluster-prod
namespace: platform
since: 2026-11-17T17:05:00Z
title: Пролив 17.11
workloads: deployment/app-api, auth, sts/vault, ds/alloy`);
  assert.ok(!("error" in r));
  assert.equal(r.context, "my-cluster-prod");
  assert.equal(r.namespace, "platform");
  assert.equal(r.title, "Пролив 17.11");
  assert.deepEqual(r.workloads, [
    { kind: "Deployment", name: "app-api" },
    { kind: "Deployment", name: "auth" },
    { kind: "StatefulSet", name: "vault" },
    { kind: "DaemonSet", name: "alloy" },
  ]);
});

test("YAML-style list under deployments:", () => {
  const r = parseBlock(`namespace: platform
deployments:
  - app-api
  - auth`);
  assert.ok(!("error" in r));
  assert.equal(r.context, null);
  assert.deepEqual(r.workloads.map((w) => w.name), ["app-api", "auth"]);
});

test("JSON form, duplicates dropped", () => {
  const r = parseBlock(JSON.stringify({ context: "c", namespace: "ns", workloads: ["a", "deployment/a", "sts/b"] }));
  assert.ok(!("error" in r));
  assert.deepEqual(r.workloads, [{ kind: "Deployment", name: "a" }, { kind: "StatefulSet", name: "b" }]);
});

test("no workloads = whole namespace", () => {
  const r = parseBlock("namespace: argocd");
  assert.ok(!("error" in r));
  assert.equal(r.workloads.length, 0);
});

test("errors: missing namespace, bad date, bad names skipped", () => {
  assert.ok("error" in parseBlock("workloads: a"));
  assert.ok("error" in parseBlock("namespace: x\nsince: yesterday-ish"));
  const r = parseBlock("namespace: x\nworkloads: Bad_Name, ok, ../etc");
  assert.ok(!("error" in r));
  assert.deepEqual(r.workloads.map((w) => w.name), ["ok"]);
});
