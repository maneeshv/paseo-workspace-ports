import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export type Listener = { pid: number; name: string; port: number; targetHost: "127.0.0.1" | "::1" };

export function isWithinWorkspace(workspace: string, directory: string): boolean {
  const path = relative(workspace, directory);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function fields(output: string): string[] {
  return output.split("\0").map((field) => field.replace(/^\n/, ""));
}

export function parseListeners(output: string): Listener[] {
  const listeners = new Map<string, Listener>();
  let pid = 0;
  let name = "Process";
  let family = "";
  for (const field of fields(output)) {
    const value = field.slice(1);
    if (field[0] === "p") {
      pid = /^\d+$/.test(value) ? Number(value) : 0;
      name = "Process";
      family = "";
    } else if (field[0] === "c") name = value;
    else if (field[0] === "f") family = "";
    else if (field[0] === "t") family = value;
    else if (field[0] === "n" && Number.isSafeInteger(pid) && pid > 0) {
      const match = /^(\*|127\.0\.0\.1|\[::1\]|\[::\]|0\.0\.0\.0):(\d+)$/.exec(value);
      if (!match) continue;
      const port = Number(match[2]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const targetHost = match[1].startsWith("[") || (match[1] === "*" && family === "IPv6") ? "::1" : "127.0.0.1";
      const key = `${pid}:${port}`;
      if (!listeners.has(key) || targetHost === "127.0.0.1") listeners.set(key, { pid, name, port, targetHost });
    }
  }
  return [...listeners.values()];
}

export function parseWorkingDirectories(output: string): Map<number, string> {
  const directories = new Map<number, string>();
  let pid = 0;
  for (const field of fields(output)) {
    if (field[0] === "p") pid = Number(field.slice(1));
    if (field[0] === "n" && Number.isSafeInteger(pid) && pid > 0 && isAbsolute(field.slice(1))) {
      directories.set(pid, field.slice(1));
    }
  }
  return directories;
}

async function lsof(args: string[]): Promise<string> {
  try {
    const { stdout } = await execute("/usr/sbin/lsof", args, { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    // lsof returns 1 for an empty selection, including a process that just exited.
    const result = error as { code?: unknown; stdout?: string; stderr?: string };
    if (result.code === 1 && !result.stderr) return result.stdout ?? "";
    throw new Error("Could not inspect listening processes with lsof.");
  }
}

export async function discoverWorkspaceListeners(workspaceDirectory: string): Promise<Listener[]> {
  if (process.platform !== "darwin") throw new Error("Automatic port discovery currently requires macOS.");
  const workspace = await realpath(workspaceDirectory);
  const listeners = parseListeners(await lsof(["-nP", "-iTCP", "-sTCP:LISTEN", "-F0pcfnt"]));
  if (listeners.length === 0) return [];
  const pids = [...new Set(listeners.map(({ pid }) => pid))].join(",");
  const directories = parseWorkingDirectories(await lsof(["-a", "-p", pids, "-d", "cwd", "-F0pn"]));
  const allowed = new Set<number>();
  await Promise.all([...directories].map(async ([pid, directory]) => {
    try {
      if (isWithinWorkspace(workspace, await realpath(directory))) allowed.add(pid);
    } catch { /* Processes and directories may disappear during discovery. */ }
  }));
  // shortcut: cwd is evidence of association, not agent ownership; managed services provide ownership.
  return listeners.filter(({ pid }) => allowed.has(pid));
}
