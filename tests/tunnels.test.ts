import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi, PaseoTerminalCreateOptions, PaseoTerminalHandle } from "@getpaseo/client";
import { disconnectTunnel, inspectTunnel, listTunnels, openTunnel, TUNNEL_SCRIPT, tunnelName, type TunnelRequest } from "#client/tunnels";

const request: TunnelRequest = {
  remoteServerId: "remote", workspaceId: "workspace", appId: "web",
  alias: "other-mac", localPort: 8790, remotePort: 3000,
  targetHost: "127.0.0.1", helperWorkspaceId: "helper",
};
const ready = () => [`PASEO_PORTS_READY ${Math.floor(Date.now() / 1000)}`];

function mockPaseo(initial = false, output = ready) {
  let present = initial;
  const created: PaseoTerminalCreateOptions[] = [];
  let kills = 0;
  const entry = { id: "owned-terminal", name: tunnelName(request), workspaceId: "helper", cwd: "/tmp" };
  const terminal = {
    id: entry.id,
    capture: async () => ({ lines: output(), terminalId: entry.id, totalLines: 1, requestId: "" }),
    kill: async () => { kills++; present = false; },
  } as unknown as PaseoTerminalHandle;
  const paseo = {
    terminals: {
      list: async () => ({ entries: present ? [entry] : [], requestId: "" }),
      create: async (options: PaseoTerminalCreateOptions) => { created.push(options); present = true; return terminal; },
      ref: () => terminal,
    },
  } as unknown as PaseoApi;
  return { paseo, created, terminal, entry, kills: () => kills };
}

test("creates one owned SSH terminal and deduplicates concurrent opens", async () => {
  const mock = mockPaseo();
  const [first, second] = await Promise.all([openTunnel(mock.paseo, request), openTunnel(mock.paseo, request)]);
  assert.equal(first, second);
  assert.equal(first.status, "running");
  assert.equal(first.url, "http://127.0.0.1:8790");
  assert.equal(mock.created.length, 1);
  assert.equal(mock.created[0].command, "/bin/sh");
  assert.deepEqual(mock.created[0].args?.slice(2), ["paseo-ports", "other-mac", "8790", "127.0.0.1", "3000"]);
  assert.equal(mock.created[0].args?.[1], TUNNEL_SCRIPT);
  assert.equal((await openTunnel(mock.paseo, request)).terminalId, first.terminalId);
  assert.equal(mock.created.length, 1);
});

test("rejects injection and invalid ports before accessing terminals", () => {
  const mock = mockPaseo();
  for (const alias of ["-oProxyCommand=evil", "host;evil", "$(evil)", "user@host@other", "host\n"]) {
    assert.throws(() => openTunnel(mock.paseo, { ...request, alias }), /alias/);
  }
  for (const localPort of [0, 65536, 1.2, NaN]) {
    assert.throws(() => openTunnel(mock.paseo, { ...request, localPort }), /Ports/);
  }
  assert.equal(mock.created.length, 0);
  assert.throws(() => openTunnel(mock.paseo, { ...request, localPort: 80 }), /Local ports/);
});

test("allows user@host but isolates it as one positional argument", async () => {
  const mock = mockPaseo();
  await openTunnel(mock.paseo, { ...request, alias: "developer@other-mac" });
  assert.equal(mock.created[0].args?.[3], "developer@other-mac");
});

test("recovers workspace tunnel requests without relying on current application rows", async () => {
  const mock = mockPaseo(true);
  const recovered = await listTunnels(mock.paseo, "helper", "remote", "workspace");
  assert.deepEqual(recovered[0].request, request);
  assert.equal(recovered[0].state.status, "running");
  assert.deepEqual(await listTunnels(mock.paseo, "helper", "other", "workspace"), []);
  mock.entry.name = "Paseo Ports v1 invalid-json";
  assert.deepEqual(await listTunnels(mock.paseo, "helper", "remote", "workspace"), []);
});

test("brackets the IPv6 loopback destination in the argument, not source text", async () => {
  const mock = mockPaseo();
  await openTunnel(mock.paseo, { ...request, targetHost: "::1" });
  assert.equal(mock.created[0].args?.[5], "[::1]");
});

test("missing terminal is disconnected; stale heartbeat and exited shell are not running", async () => {
  assert.equal(await inspectTunnel(mockPaseo().paseo, request), null);
  assert.equal((await inspectTunnel(mockPaseo(true, () => ["PASEO_PORTS_READY 100"]).paseo, request))?.status, "disconnected");
  assert.equal((await inspectTunnel(mockPaseo(true, () => [...ready(), "PASEO_PORTS_EXIT"]).paseo, request))?.status, "disconnected");
  assert.equal((await inspectTunnel(mockPaseo(true, () => []).paseo, request))?.status, "connecting");
});

test("failed startup cleans only its newly created terminal", async () => {
  const mock = mockPaseo(false, () => ["Permission denied.", "PASEO_PORTS_EXIT"]);
  await assert.rejects(openTunnel(mock.paseo, request), /SSH exited/);
  assert.equal(mock.kills(), 1);
  const existing = mockPaseo(true, () => ["PASEO_PORTS_EXIT"]);
  await assert.rejects(openTunnel(existing.paseo, request), /Disconnect/);
  assert.equal(existing.kills(), 0);
});

test("disconnect waits for in-flight startup and kills its resulting terminal", async () => {
  const mock = mockPaseo();
  await Promise.all([openTunnel(mock.paseo, request), disconnectTunnel(mock.paseo, request)]);
  assert.equal(mock.kills(), 1);
  assert.equal(await inspectTunnel(mock.paseo, request), null);
});

test("startup timeout cleans the terminal; cleanup errors remain visible", async (context) => {
  let now = 0;
  context.mock.method(Date, "now", () => { now += 20_000; return now; });
  const mock = mockPaseo(false, () => []);
  await assert.rejects(openTunnel(mock.paseo, request), /18 seconds/);
  assert.equal(mock.kills(), 1);
  context.mock.restoreAll();
  const failed = mockPaseo(false, () => ["PASEO_PORTS_EXIT"]);
  failed.terminal.kill = async () => { throw new Error("offline"); };
  await assert.rejects(openTunnel(failed.paseo, request), /Cleanup failed/);
});

test("does not operate on a renamed or different workspace terminal", async () => {
  const mock = mockPaseo(true);
  mock.entry.name = "Unrelated terminal";
  await disconnectTunnel(mock.paseo, request);
  assert.equal(mock.kills(), 0);
  mock.entry.name = tunnelName(request);
  mock.entry.workspaceId = "different";
  assert.equal(await inspectTunnel(mock.paseo, request), null);
});

test("shell wrapper is syntactically valid and confirms forwarding before readiness", () => {
  execFileSync("/bin/sh", ["-n"], { input: TUNNEL_SCRIPT });
  assert.ok(TUNNEL_SCRIPT.indexOf("-O forward") < TUNNEL_SCRIPT.indexOf("PASEO_PORTS_READY"));
  assert.match(TUNNEL_SCRIPT, /ClearAllForwardings=yes/);
  assert.match(TUNNEL_SCRIPT, /StrictHostKeyChecking=yes/);
  assert.match(TUNNEL_SCRIPT, /BatchMode=yes/);
  assert.match(TUNNEL_SCRIPT, /-F \/dev\/null -S "\$sock" -O forward/);
  assert.doesNotMatch(TUNNEL_SCRIPT, /\brm\b|\bkillall\b|\bpkill\b/);
});

test("shell lifecycle uses private socket, reports readiness, and cleans its owned master", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-ports-test-"));
  const fake = join(dir, "ssh");
  const pidFile = join(dir, "pid");
  const log = join(dir, "commands");
  writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_LOG"
case " $* " in
  *" -O check "*) test -f "$TEST_PID" && kill -0 "$(cat "$TEST_PID")" 2>/dev/null; exit $? ;;
  *" -O forward "*) exit "\${TEST_FAIL:-0}" ;;
  *" -O exit "*) kill "$(cat "$TEST_PID")" 2>/dev/null; exit 0 ;;
esac
echo $$ > "$TEST_PID"
exec /bin/sleep 60
`, { mode: 0o700 });
  const script = TUNNEL_SCRIPT.replaceAll("/usr/bin/ssh", fake).replaceAll("/bin/sleep 5", "/bin/sleep 0.02");
  const child = spawn("/bin/sh", ["-c", script, "test", "test-host", "8790", "127.0.0.1", "3000"], {
    env: { ...process.env, TEST_PID: pidFile, TEST_LOG: log },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let signalled = false;
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("PASEO_PORTS_READY") && !signalled) {
        signalled = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("exit", resolve);
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    await exit;
    assert.equal(signalled, true, output);
    assert.match(output, /PASEO_PORTS_EXIT/);
    const commands = readFileSync(log, "utf8");
    assert.match(commands, /-O forward -o ExitOnForwardFailure=yes -L 127.0.0.1:8790:127.0.0.1:3000 test-host/);
    assert.match(commands, /-O exit test-host/);
    const masterPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.throws(() => process.kill(masterPid, 0), /ESRCH/);
    const failure = spawnSync("/bin/sh", ["-c", script, "test", "test-host", "8790", "127.0.0.1", "3000"], {
      env: { ...process.env, TEST_PID: pidFile, TEST_LOG: log, TEST_FAIL: "1" },
      encoding: "utf8", timeout: 4000,
    });
    assert.equal(failure.status, 1, failure.stderr);
    assert.doesNotMatch(failure.stdout, /PASEO_PORTS_READY/);
    assert.match(failure.stdout, /PASEO_PORTS_EXIT/);
    const failedMasterPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.throws(() => process.kill(failedMasterPid, 0), /ESRCH/);
  } finally {
    clearTimeout(watchdog);
    child.kill("SIGTERM");
    execFileSync("/usr/bin/trash", [dir]);
  }
});
