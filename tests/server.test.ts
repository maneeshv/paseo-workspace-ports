import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { isWithinWorkspace, parseListeners, parseWorkingDirectories } from "#server/discovery";
import { appsFromProcesses, parseServices, scriptArguments, scriptProcess, validateServiceAction, type Service } from "#server/apps";

const output = (...fields: string[]) => fields.join("\0") + "\0";

test("lsof parser deduplicates dual-stack listeners and preserves IPv6-only loopback", () => {
  const listeners = parseListeners(output("p42", "cnode", "\nf1", "tIPv6", "n*:3000", "\nf2", "tIPv4", "n*:3000", "\nf3", "tIPv6", "n[::1]:8790"));
  assert.deepEqual(listeners, [
    { pid: 42, name: "node", port: 3000, targetHost: "127.0.0.1" },
    { pid: 42, name: "node", port: 8790, targetHost: "::1" },
  ]);
});

test("lsof parser ignores malformed ports and bindings unreachable through loopback", () => {
  assert.deepEqual(parseListeners(output("p4", "cnode", "f1", "tIPv4", "n192.168.1.2:3000", "n*:0", "n*:65536", "n*:80->other:80", "px", "n*:3000")), []);
});

test("cwd parser preserves spaces; containment rejects siblings and ancestors", () => {
  assert.deepEqual([...parseWorkingDirectories(output("p42", "n/Users/person/My Project", "\np43", "n/tmp/other"))], [[42, "/Users/person/My Project"], [43, "/tmp/other"]]);
  assert.equal(isWithinWorkspace("/project", "/project"), true);
  assert.equal(isWithinWorkspace("/project", "/project/web"), true);
  assert.equal(isWithinWorkspace("/project", "/project-other"), false);
  assert.equal(isWithinWorkspace("/project", "/"), false);
  assert.equal(isWithinWorkspace("/project", "/project/../outside"), false);
});

test("service parser filters ordinary scripts and validates values from CLI", () => {
  const service = { scriptName: "web", type: "service", port: 3000, lifecycle: "running", terminalId: "terminal-1" };
  assert.deepEqual(parseServices(JSON.stringify([service, { ...service, scriptName: "test", type: "script" }])), [service]);
  assert.throws(() => parseServices(JSON.stringify([{ ...service, port: 70000 }])));
  assert.throws(() => parseServices(JSON.stringify({ error: { message: "failed" } })));
  assert.throws(() => parseServices(JSON.stringify([{ ...service, lifecycle: "invented" }])));
});

test("script argv preserves literal names and blocks invalid actions and identifiers", () => {
  const args = scriptArguments("workspace-1", "start", "--host=other; echo pwned");
  assert.deepEqual(args.slice(-2), ["--", "--host=other; echo pwned"]);
  assert.equal(args[args.indexOf("--workspace") + 1], "workspace-1");
  assert.throws(() => scriptArguments("workspace\nother", "ls"));
  assert.throws(() => scriptArguments("workspace", "stop", ""));
  assert.throws(() => scriptArguments("workspace", "destroy" as "stop", "web"));
});

test("service actions reject unexpected results and applications that immediately stop", () => {
  const running = JSON.stringify({ scriptName: "web", type: "service", port: 3000, lifecycle: "running", terminalId: "terminal-1" });
  const stopped = JSON.stringify({ scriptName: "web", type: "service", port: 3000, lifecycle: "stopped", terminalId: null });
  assert.doesNotThrow(() => validateServiceAction(running, "web", "start"));
  assert.doesNotThrow(() => validateServiceAction(stopped, "web", "stop"));
  assert.throws(() => validateServiceAction(stopped, "web", "start"), /did not stay running/);
  assert.throws(() => validateServiceAction(running, "other", "start"), /unexpected service/);
});

test("managed app readiness requires a discovered listener, not just an assigned port", () => {
  const web: Service = { scriptName: "web", type: "service", port: 3000, lifecycle: "running", terminalId: "terminal-1" };
  assert.equal(appsFromProcesses([web], [])[0].listening, false);
  const listener = { pid: 42, name: "node", port: 3000, targetHost: "::1" as const };
  const ready = appsFromProcesses([web], [listener]);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].listening, true);
  assert.equal(ready[0].targetHost, "::1");
  const stopped = appsFromProcesses([{ ...web, lifecycle: "stopped" }], [listener]);
  assert.equal(stopped.find(({ source }) => source === "managed")?.listening, false);
  assert.equal(stopped.find(({ source }) => source === "detected")?.listening, true);
});

test("CLI environment drops inherited remote routing, preserves home and honors explicit executable", () => {
  const inherited = { PASEO_HOST: "ssh://other-host", PASEO_HOME: "/tmp/owner-home", PASEO_CLI: "/custom/paseo", PATH: "/usr/bin" };
  const selected = scriptProcess(inherited);
  assert.equal(selected.command, "/custom/paseo");
  assert.equal(selected.env.PASEO_HOST, undefined);
  assert.equal(selected.env.PASEO_HOME, "/tmp/owner-home");
  assert.equal(inherited.PASEO_HOST, "ssh://other-host");
});

test("macOS uses bundled CLI when noninteractive PATH cannot find paseo", {
  skip: process.platform !== "darwin" || !existsSync("/Applications/Paseo.app/Contents/Resources/bin/paseo"),
}, () => {
  assert.equal(scriptProcess({ PATH: "/nonexistent" }).command, "/Applications/Paseo.app/Contents/Resources/bin/paseo");
});
