import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi, PaseoTerminal, PaseoTerminalCreateOptions } from "@getpaseo/client";
import type { App } from "#shared/contracts";
import type { listApps } from "#server/apps";
import {
  listShares, parseAvailability, parseServeMappings, parseShareName, SHARE_SCRIPT, shareName, startShare, stopShare, tailscaleCommand,
} from "#server/share";

const DNS = "work.example.ts.net";
const STATUS_OK = { BackendState: "Running", Self: { DNSName: `${DNS}.` }, CertDomains: [DNS] };
const foreground = (port: number, target: string) => ({
  Foreground: { session1: { TCP: { [port]: { HTTPS: true } }, Web: { [`${DNS}:${port}`]: { Handlers: { "/": { Proxy: target } } } } } },
});

// A real executable stands in for the Tailscale CLI so the execFile path is exercised.
const dir = mkdtempSync(join(tmpdir(), "paseo-ports-share-test-"));
const fakeCli = join(dir, "tailscale");
const statusFile = join(dir, "status.json");
const serveFile = join(dir, "serve.json");
const argvLog = join(dir, "argv");
writeFileSync(fakeCli, `#!/bin/sh
printf '%s\\n' "$*" >> "${argvLog}"
case "$1 $2" in
  "status --json") cat "${statusFile}" ;;
  "serve status") cat "${serveFile}" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`, { mode: 0o700 });
const setStatus = (value: unknown) => writeFileSync(statusFile, JSON.stringify(value));
const setServe = (value: unknown) => writeFileSync(serveFile, JSON.stringify(value));
const previousCli = process.env.PASEO_PORTS_TAILSCALE_CLI;
process.env.PASEO_PORTS_TAILSCALE_CLI = fakeCli;
beforeEach(() => { setStatus(STATUS_OK); setServe({}); writeFileSync(argvLog, ""); });
after(() => {
  if (previousCli === undefined) delete process.env.PASEO_PORTS_TAILSCALE_CLI;
  else process.env.PASEO_PORTS_TAILSCALE_CLI = previousCli;
  execFileSync("/usr/bin/trash", [dir]);
});

const app = (overrides: Partial<App> = {}): App => ({
  id: "managed:web", name: "web", source: "managed", status: "running", listening: true, port: 3000, pid: null,
  scriptName: "web", terminalId: null, detail: "", targetHost: "127.0.0.1", ...overrides,
});
const appsOf = (...apps: App[]) => (async () => ({ apps, warnings: [] })) as unknown as typeof listApps;
const started = () => [`PASEO_PORTS_SHARE_START ${Math.floor(Date.now() / 1000)}`];

function mockPaseo(initial: PaseoTerminal[] = [], output: (id: string) => string[] = started) {
  const entries = [...initial];
  const created: PaseoTerminalCreateOptions[] = [];
  const killed: string[] = [];
  const handle = (entry: PaseoTerminal) => ({
    id: entry.id,
    capture: async () => ({ lines: output(entry.id), terminalId: entry.id, totalLines: 1, requestId: "" }),
    kill: async () => { killed.push(entry.id); entries.splice(entries.findIndex(({ id }) => id === entry.id), 1); },
  });
  const paseo = {
    workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: "/tmp" }) }) },
    terminals: {
      list: async ({ workspaceId }: { workspaceId: string }) => ({ entries: entries.filter((entry) => entry.workspaceId === workspaceId), requestId: "" }),
      create: async (options: PaseoTerminalCreateOptions) => {
        created.push(options);
        const entry = { id: `share-${created.length}`, name: options.name ?? "", workspaceId: options.workspaceId, cwd: "/tmp" };
        entries.push(entry);
        return handle(entry);
      },
      ref: (entry: PaseoTerminal) => handle(entry),
    },
  } as unknown as PaseoApi;
  return { paseo, created, killed, entries };
}
const owned = (id: string, appId = "managed:web", appPort = 3000, httpsPort = 3000): PaseoTerminal =>
  ({ id, name: shareName("ws", appId, appPort, httpsPort), workspaceId: "ws", cwd: "/tmp" });

test("availability requires a running backend, a DNS name and HTTPS certificates", () => {
  assert.deepEqual(parseAvailability(JSON.stringify(STATUS_OK)), { ok: true, dnsName: DNS });
  assert.equal((parseAvailability(JSON.stringify({ ...STATUS_OK, BackendState: "NeedsLogin" })) as { reason: string }).reason, "logged-out");
  assert.equal((parseAvailability(JSON.stringify({ ...STATUS_OK, BackendState: "Stopped" })) as { reason: string }).reason, "not-running");
  assert.equal((parseAvailability(JSON.stringify({ ...STATUS_OK, CertDomains: null })) as { reason: string }).reason, "https-disabled");
  assert.equal((parseAvailability(JSON.stringify({ ...STATUS_OK, Self: { DNSName: "bad host/." }, CertDomains: ["bad host/"] })) as { reason: string }).reason, "https-disabled");
});

test("serve mappings include background config and every foreground session", () => {
  const output = JSON.stringify({
    TCP: { 443: { HTTPS: true }, 9000: { TCPForward: "127.0.0.1:22" } },
    Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } } },
    ...foreground(3000, "http://127.0.0.1:3000"),
  });
  assert.deepEqual(parseServeMappings(output), [
    { httpsPort: 443, target: "http://127.0.0.1:8080" },
    { httpsPort: 9000, target: "another Tailscale handler" },
    { httpsPort: 3000, target: "http://127.0.0.1:3000" },
  ]);
  assert.deepEqual(parseServeMappings("{}"), []);
});

test("share names round-trip; renamed, foreign and malformed terminals are not owned", () => {
  const entry = owned("t1");
  assert.deepEqual(parseShareName(entry, "ws"), { entry, appId: "managed:web", appPort: 3000, httpsPort: 3000 });
  assert.equal(parseShareName({ ...entry, workspaceId: "other" }, "ws"), null);
  assert.equal(parseShareName({ ...entry, name: entry.name.replace("3000]", "3000 ]") }, "ws"), null);
  assert.equal(parseShareName({ ...entry, name: 'Paseo Ports share v1 ["ws","web",3000]' }, "ws"), null);
  assert.equal(parseShareName({ ...entry, name: 'Paseo Ports share v1 ["ws","web",3000,70000]' }, "ws"), null);
  assert.throws(() => shareName("ws", "bad\nid", 3000, 3000));
});

test("explicit CLI must be absolute; PATH lookup finds tailscale", () => {
  assert.equal(tailscaleCommand({ PASEO_PORTS_TAILSCALE_CLI: "tailscale" }), null);
  assert.equal(tailscaleCommand({ PASEO_PORTS_TAILSCALE_CLI: fakeCli }), fakeCli);
  assert.equal(tailscaleCommand({ PATH: dir }), fakeCli);
});

test("wrapper is valid, foreground-only, and passes values as positional arguments", () => {
  execFileSync("/bin/sh", ["-n"], { input: SHARE_SCRIPT });
  assert.doesNotMatch(SHARE_SCRIPT, /funnel|reset|--bg|\boff\b|\brm\b/);
  const log = join(dir, "wrapper-argv");
  const fake = join(dir, "fake-serve");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nexit 1\n`, { mode: 0o700 });
  const run = spawnSync("/bin/sh", ["-c", SHARE_SCRIPT, "paseo-ports-share", fake, "8443", "3000; echo injected"], { encoding: "utf8" });
  assert.match(run.stdout, /^PASEO_PORTS_SHARE_START \d+$/m);
  assert.match(run.stdout, /^PASEO_PORTS_SHARE_EXIT$/m);
  assert.doesNotMatch(run.stdout, /^injected$/m);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["serve", "--yes", "--https=8443", "http://127.0.0.1:3000; echo injected"]);
});

test("starts one owned foreground share and deduplicates concurrent requests", async () => {
  const mock = mockPaseo();
  // Port is free at preflight; the mapping appears once the share terminal starts.
  const original = mock.paseo.terminals.create;
  (mock.paseo.terminals as { create: typeof original }).create = async (options) => {
    const handle = await original(options);
    setServe(foreground(8443, "http://127.0.0.1:3000"));
    return handle;
  };
  const [first, second] = await Promise.all([
    startShare(mock.paseo, "ws", "managed:web", 8443, appsOf(app())),
    startShare(mock.paseo, "ws", "managed:web", 8443, appsOf(app())),
  ]);
  assert.equal(first, second);
  assert.equal(first.status, "running");
  assert.equal(first.url, `https://${DNS}:8443`);
  assert.equal(mock.created.length, 1);
  assert.equal(mock.created[0].name, shareName("ws", "managed:web", 3000, 8443));
  assert.deepEqual(mock.created[0].args, ["-c", SHARE_SCRIPT, "paseo-ports-share", fakeCli, "8443", "3000"]);
  const again = await startShare(mock.paseo, "ws", "managed:web", 8443, appsOf(app()));
  assert.equal(again.terminalId, first.terminalId);
  assert.equal(mock.created.length, 1);
  assert.doesNotMatch(readFileSync(argvLog, "utf8"), /funnel|reset|--bg|\boff\b/);
});

test("a new terminal is still starting before its shell prints the start marker", async () => {
  let captures = 0;
  const mock = mockPaseo([], () => (++captures <= 2 ? [] : started()));
  const original = mock.paseo.terminals.create;
  (mock.paseo.terminals as { create: typeof original }).create = async (options) => {
    const handle = await original(options);
    setTimeout(() => setServe(foreground(8443, "http://127.0.0.1:3000")), 700);
    return handle;
  };
  const share = await startShare(mock.paseo, "ws", "managed:web", 8443, appsOf(app()));
  assert.equal(share.status, "running");
  assert.ok(captures > 2);
  assert.deepEqual(mock.killed, []);
});

test("concurrent starts on one HTTPS port for different apps create only one terminal", async () => {
  const mock = mockPaseo();
  const original = mock.paseo.terminals.create;
  (mock.paseo.terminals as { create: typeof original }).create = async (options) => {
    const handle = await original(options);
    setServe(foreground(8443, "http://127.0.0.1:3000"));
    return handle;
  };
  const docs = app({ id: "managed:docs", name: "docs", port: 4000 });
  const [web, other] = await Promise.allSettled([
    startShare(mock.paseo, "ws", "managed:web", 8443, appsOf(app(), docs)),
    startShare(mock.paseo, "ws", "managed:docs", 8443, appsOf(app(), docs)),
  ]);
  assert.equal(web.status, "fulfilled");
  assert.equal(other.status, "rejected");
  assert.match(String((other as PromiseRejectedResult).reason), /already being shared/);
  assert.equal(mock.created.length, 1);
});

test("refuses unshareable apps and served ports before creating a terminal", async () => {
  const mock = mockPaseo();
  await assert.rejects(startShare(mock.paseo, "ws", "managed:web", 8443, appsOf()), /isn't listening/);
  await assert.rejects(startShare(mock.paseo, "ws", "managed:web", 8443, appsOf(app({ status: "stopped" }))), /isn't listening/);
  await assert.rejects(startShare(mock.paseo, "ws", "managed:web", 8443, appsOf(app({ listening: false }))), /isn't listening/);
  await assert.rejects(startShare(mock.paseo, "ws", "managed:web", 8443, appsOf(app({ targetHost: "::1" }))), /IPv4 loopback only/);
  setServe(foreground(8443, "http://127.0.0.1:9999"));
  await assert.rejects(startShare(mock.paseo, "ws", "managed:web", 8443, appsOf(app())), /already served by Tailscale/);
  setServe({});
  setStatus({ ...STATUS_OK, CertDomains: [] });
  await assert.rejects(startShare(mock.paseo, "ws", "managed:web", 8443, appsOf(app())), /HTTPS certificates/);
  assert.throws(() => startShare(mock.paseo, "ws", "managed:web", 70000, appsOf(app())));
  assert.equal(mock.created.length, 0);
});

test("failed start reports Tailscale output and kills only its own terminal", async () => {
  const other = owned("other-share", "managed:docs", 4000, 4000);
  const mock = mockPaseo([other], (id) => id === "other-share" ? started()
    : [...started(), "listener already exists for port 8443", "PASEO_PORTS_SHARE_EXIT"]);
  await assert.rejects(startShare(mock.paseo, "ws", "managed:web", 8443, appsOf(app())), /listener already exists for port 8443/);
  assert.deepEqual(mock.killed, ["share-1"]);
  assert.deepEqual(mock.entries.map(({ id }) => id), ["other-share"]);
});

test("an existing failed share must be stopped before sharing again", async () => {
  const mock = mockPaseo([owned("old", "managed:web", 3000, 8443)], () => [...started(), "PASEO_PORTS_SHARE_EXIT"]);
  await assert.rejects(startShare(mock.paseo, "ws", "managed:web", 8443, appsOf(app())), /Stop sharing before sharing again/);
  assert.equal(mock.created.length, 0);
  assert.deepEqual(mock.killed, []);
});

test("list reports running, starting, failed and foreign mappings", async () => {
  const stale = `PASEO_PORTS_SHARE_START ${Math.floor(Date.now() / 1000) - 60}`;
  const mock = mockPaseo([
    owned("running", "managed:web", 3000, 8443),
    owned("starting", "managed:api", 4000, 8444),
    owned("stuck", "managed:docs", 5000, 8445),
    owned("exited", "managed:old", 6000, 8446),
    { id: "not-ours", name: "Paseo Ports share v1 renamed", workspaceId: "ws", cwd: "/tmp" },
  ], (id) => ({
    running: started(), starting: started(), stuck: [stale, "To enable HTTPS, visit the admin console"], exited: [...started(), "PASEO_PORTS_SHARE_EXIT"],
  } as Record<string, string[]>)[id] ?? []);
  setServe({ ...foreground(8443, "http://127.0.0.1:3000"), TCP: { 9443: { HTTPS: true } } });
  const result = await listShares(mock.paseo, "ws");
  assert.deepEqual(result.availability, { ok: true, dnsName: DNS });
  assert.deepEqual(Object.fromEntries(result.shares.map(({ terminalId, status }) => [terminalId, status])),
    { running: "running", starting: "starting", stuck: "failed", exited: "failed" });
  assert.match(result.shares.find(({ terminalId }) => terminalId === "stuck")?.detail ?? "", /To enable HTTPS/);
  assert.deepEqual(result.foreign, [{ httpsPort: 9443, target: "another Tailscale handler" }]);
});

test("list degrades to an unavailable reason without hiding owned shares", async () => {
  const mock = mockPaseo([owned("running")]);
  setStatus({ ...STATUS_OK, BackendState: "Stopped" });
  const result = await listShares(mock.paseo, "ws");
  assert.equal(result.availability.ok, false);
  assert.equal(result.shares.length, 1);
  assert.equal(result.shares[0].url, "");
  assert.deepEqual(result.foreign, []);
});

test("stop kills only owned share terminals and tolerates ones already gone", async () => {
  const foreign = { id: "user-terminal", name: "dev server", workspaceId: "ws", cwd: "/tmp" };
  const mock = mockPaseo([owned("share"), foreign]);
  await assert.rejects(stopShare(mock.paseo, "ws", "user-terminal"), /not a Workspace Ports share/);
  await stopShare(mock.paseo, "ws", "share");
  await stopShare(mock.paseo, "ws", "share");
  await stopShare(mock.paseo, "other-ws", "user-terminal");
  assert.deepEqual(mock.killed, ["share"]);
});
