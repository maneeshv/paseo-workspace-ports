import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createPaseoApi } from "@getpaseo/client";
import { createHostClient } from "@getpaseo/client/node";
import { appLogs, controlApp, listApps } from "#server/apps";
import { listShares, startShare, stopShare } from "#server/share";
import { TUNNEL_SCRIPT } from "#client/tunnels";

const execute = promisify(execFile);

// Explicit opt-in: this test creates and archives its own workspace on the local daemon.
test("managed app listing, start, HTTP, logs, and stop against local Paseo", {
  skip: process.env.PASEO_PORTS_INTEGRATION !== "1",
  timeout: process.env.PASEO_PORTS_TAILSCALE === "1" ? 240_000 : 90_000,
}, async (t) => {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const cli = process.env.PASEO_CLI || "paseo";
  const run = async (args: string[]) => JSON.parse((await execute(cli, [...args, "--home", home, "--json"], { timeout: 30_000 })).stdout);
  const status = await run(["status"]);
  assert.match(status.listen, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, "Integration requires a loopback daemon");
  const client = createHostClient(status.listen, {
    clientId: "workspace-ports-integration-test",
    clientType: "cli",
    localCredential: async () => (await readFile(join(home, "local-credential"), "utf8")).trim(),
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const api = createPaseoApi(client);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "paseo-ports-integration-")));
  let workspaceId: string | undefined;
  try {
    await writeFile(join(directory, "server.cjs"), `const http = require('node:http');\nhttp.createServer((req, res) => res.end('workspace-ports-integration-ok')).listen(Number(process.env.PASEO_PORT), '127.0.0.1', () => console.log('workspace-ports-integration-ready'));\n`);
    await writeFile(join(directory, "paseo.json"), JSON.stringify({ scripts: {
      web: { type: "service", command: `'${process.execPath.replaceAll("'", "'\\''")}' server.cjs` },
      ordinary: { command: "echo not-a-service" },
    } }));
    const created = await run(["workspace", "create", "--isolation", "local", "--path", directory, "--title", "Ports disposable integration test"]);
    workspaceId = created.workspaceId ?? created.workspace?.workspaceId;
    assert.ok(workspaceId, `Workspace creation did not return an ID: ${JSON.stringify(created)}`);
    await client.connect();
    let listing = await listApps(api, workspaceId);
    assert.deepEqual(listing.warnings, []);
    assert.equal(listing.apps.filter(({ source }) => source === "managed").length, 1);
    assert.equal(listing.apps[0]?.status, "stopped");
    await assert.rejects(controlApp(api, workspaceId, "ordinary", "start"), /not a configured Paseo service/);
    await controlApp(api, workspaceId, "web", "start");
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      listing = await listApps(api, workspaceId);
      const app = listing.apps.find(({ id }) => id === "managed:web");
      if (app?.status === "running" && app.port) {
        try { ready = await (await fetch(`http://127.0.0.1:${app.port}`)).text() === "workspace-ports-integration-ok"; } catch {}
        if (ready) break;
      }
      await delay(100);
    }
    assert.equal(ready, true, "Managed service should respond through its assigned port");
    assert.equal(listing.apps.filter(({ source }) => source === "detected").length, 0, "Managed listener should not duplicate as detected");
    assert.match(await appLogs(api, workspaceId, "web"), /workspace-ports-integration-ready/);
    const port = listing.apps.find(({ id }) => id === "managed:web")!.port!;
    if (process.env.PASEO_PORTS_TAILSCALE === "1") {
      // Opt-in: briefly changes this Mac's Tailscale Serve config (tailnet-only foreground share on the app's port).
      const share = await startShare(api, workspaceId, "managed:web", port);
      try {
        assert.equal(share.status, "running");
        // The first TLS handshake can take tens of seconds while Tailscale issues the certificate.
        const response = await fetch(share.url); // Bounded by the test timeout.
        assert.equal(await response.text(), "workspace-ports-integration-ok");
        assert.equal((await listShares(api, workspaceId)).shares.find(({ terminalId }) => terminalId === share.terminalId)?.status, "running");
      } finally {
        await stopShare(api, workspaceId, share.terminalId);
      }
      let removed = false;
      for (let attempt = 0; attempt < 40 && !removed; attempt++) {
        await delay(250);
        const after = await listShares(api, workspaceId);
        removed = after.shares.length === 0 && !after.foreign.some(({ httpsPort }) => httpsPort === port);
      }
      assert.equal(removed, true, "Stopping the share terminal should remove its Serve mapping");
      assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "workspace-ports-integration-ok", "Stopping a share must not stop the app");
      t.diagnostic(`tailnet share on :${port} was running, served HTTPS, and its mapping was removed on stop`);
    }
    await controlApp(api, workspaceId, "web", "stop");
    assert.equal((await listApps(api, workspaceId)).apps.find(({ id }) => id === "managed:web")?.status, "stopped");
    await assert.rejects(fetch(`http://127.0.0.1:${port}`), "Stopping the service should release its listener");
  } finally {
    try {
      if (workspaceId) await run(["workspace", "archive", workspaceId]);
    } finally {
      await api.dispose();
      await client.close();
      await execute("trash", [directory]);
    }
  }
});

test("SSH shell forwards real HTTP over a private control socket and releases it on termination", {
  skip: process.env.PASEO_PORTS_INTEGRATION !== "1" || process.platform !== "darwin",
  timeout: 45_000,
}, async () => {
  const directory = await mkdtemp("/tmp/paseo-ports-ssh-test-");
  const app = createServer((_request, response) => response.end("ports-tunnel-ok"));
  const freePort = async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  };
  let sshd: ReturnType<typeof spawn> | undefined;
  let tunnel: ReturnType<typeof spawn> | undefined;
  let output = "";
  try {
    for (const name of ["host", "client"]) {
      await execute("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(directory, name)]);
    }
    await writeFile(join(directory, "authorized_keys"), await readFile(join(directory, "client.pub")), { mode: 0o600 });
    const sshPort = await freePort();
    const localPort = await freePort();
    const hostKey = (await readFile(join(directory, "host.pub"), "utf8")).split(" ").slice(0, 2).join(" ");
    await writeFile(join(directory, "known_hosts"), `[127.0.0.1]:${sshPort} ${hostKey}\n`);
    await writeFile(join(directory, "sshd_config"), [
      `Port ${sshPort}`, "ListenAddress 127.0.0.1", `HostKey ${directory}/host`,
      `PidFile ${directory}/sshd.pid`, `AuthorizedKeysFile ${directory}/authorized_keys`,
      "StrictModes no", "PasswordAuthentication no", "KbdInteractiveAuthentication no",
      "UsePAM no", "AllowTcpForwarding local", "PermitRootLogin no",
    ].join("\n") + "\n");
    await writeFile(join(directory, "ssh_config"), [
      "Host fixture", "HostName 127.0.0.1", `Port ${sshPort}`, `User ${userInfo().username}`,
      `IdentityFile ${directory}/client`, "IdentitiesOnly yes", `UserKnownHostsFile ${directory}/known_hosts`,
    ].join("\n") + "\n");
    sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", join(directory, "sshd_config")], { stdio: "ignore" });
    await delay(300);
    assert.equal(sshd.exitCode, null, "Temporary SSH daemon should start");
    app.listen(0, "127.0.0.1");
    await once(app, "listening");
    const remotePort = (app.address() as { port: number }).port;
    // Test-only SSH configuration keeps all keys, known hosts and connection settings in the fixture.
    const script = TUNNEL_SCRIPT.replace("/usr/bin/ssh -N", `/usr/bin/ssh -F '${directory}/ssh_config' -N`);
    assert.notEqual(script, TUNNEL_SCRIPT);
    tunnel = spawn("/bin/sh", ["-c", script, "paseo-ports", "fixture", String(localPort), "127.0.0.1", String(remotePort)], { stdio: ["ignore", "pipe", "pipe"] });
    tunnel.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    tunnel.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    for (let attempt = 0; attempt < 100 && !output.includes("PASEO_PORTS_READY"); attempt++) {
      if (tunnel.exitCode !== null) break;
      await delay(100);
    }
    assert.match(output, /PASEO_PORTS_READY \d+/, "The actual SSH forward should report ready");
    assert.equal(await (await fetch(`http://127.0.0.1:${localPort}`)).text(), "ports-tunnel-ok");
    const exited = once(tunnel, "exit");
    tunnel.kill("SIGTERM");
    await exited;
    assert.match(output, /PASEO_PORTS_EXIT/);
    await assert.rejects(fetch(`http://127.0.0.1:${localPort}`), "Terminating tunnel should release the local listener");
    assert.equal(await (await fetch(`http://127.0.0.1:${remotePort}`)).text(), "ports-tunnel-ok", "Disconnect must leave the app running");
  } finally {
    if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) {
      const exited = once(tunnel, "exit");
      tunnel.kill("SIGTERM");
      await exited;
    }
    if (sshd && sshd.exitCode === null && sshd.signalCode === null) {
      const exited = once(sshd, "exit");
      sshd.kill("SIGTERM");
      await exited;
    }
    await new Promise<void>((resolve) => app.close(() => resolve()));
    await execute("trash", [directory]);
  }
});
