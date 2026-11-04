import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import type { App } from "#shared/contracts";
import { discoverWorkspaceListeners, type Listener } from "#server/discovery";

const execute = promisify(execFile);
export const identifier = z.string().min(1).max(512).refine((value) => !/[\x00-\x1f\x7f]/.test(value), "Invalid identifier");
const scriptSchema = z.object({
  scriptName: identifier,
  type: z.enum(["script", "service"]),
  port: z.number().int().min(1).max(65535).nullable(),
  lifecycle: z.enum(["running", "stopped"]),
  terminalId: identifier.nullable().optional(),
});
export type Service = z.infer<typeof scriptSchema>;

export function parseServices(output: string): Service[] {
  return z.array(scriptSchema).parse(JSON.parse(output)).filter(({ type }) => type === "service");
}

export function validateServiceAction(output: string, scriptName: string, action: "start" | "stop"): void {
  const updated = scriptSchema.parse(JSON.parse(output));
  if (updated.scriptName !== scriptName || updated.type !== "service") throw new Error("Paseo returned an unexpected service.");
  if (updated.lifecycle !== (action === "start" ? "running" : "stopped")) {
    throw new Error(`The service did not ${action === "start" ? "stay running" : "stop"}. Check its logs.`);
  }
}

export function scriptArguments(workspaceId: string, action: "ls" | "start" | "stop", name?: string): string[] {
  identifier.parse(workspaceId);
  z.enum(["ls", "start", "stop"]).parse(action);
  const args = ["script", action, "--workspace", workspaceId, "--json"];
  if (process.env.PASEO_HOME) args.push("--home", process.env.PASEO_HOME);
  if (action !== "ls") args.push("--", identifier.parse(name));
  return args;
}

/** First executable named `name` on PATH, else the first executable fallback. */
export function findExecutable(name: string, fallbacks: string[], environment: NodeJS.ProcessEnv): string | null {
  const candidates = [...(environment.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, name)), ...fallbacks];
  return candidates.find((candidate) => {
    try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
  }) ?? null;
}

export function scriptProcess(environment: NodeJS.ProcessEnv = process.env): { command: string; env: NodeJS.ProcessEnv } {
  const env = { ...environment };
  delete env.PASEO_HOST;
  if (env.PASEO_CLI) return { command: env.PASEO_CLI, env };
  const bundled = process.platform === "darwin" ? ["/Applications/Paseo.app/Contents/Resources/bin/paseo"] : [];
  return { command: findExecutable("paseo", bundled, env) ?? "paseo", env };
}

async function runScript(workspaceId: string, action: "ls" | "start" | "stop", name?: string): Promise<string> {
  try {
    const { command, env } = scriptProcess();
    const { stdout } = await execute(command, scriptArguments(workspaceId, action, name), {
      env,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch {
    throw new Error(`Paseo could not ${action === "ls" ? "list" : action} workspace services. Check the local Paseo CLI and daemon connection.`);
  }
}

export async function workspaceDirectory(paseo: PaseoApi, workspaceId: string): Promise<string> {
  identifier.parse(workspaceId);
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace) throw new Error("Workspace no longer exists.");
  return workspace.workspaceDirectory;
}

async function service(workspaceId: string, name: string): Promise<Service> {
  identifier.parse(name);
  const found = parseServices(await runScript(workspaceId, "ls")).find(({ scriptName }) => scriptName === name);
  if (!found) throw new Error("This application is not a configured Paseo service.");
  return found;
}

export async function listApps(paseo: PaseoApi, workspaceId: string): Promise<{ apps: App[]; warnings: string[] }> {
  const directory = await workspaceDirectory(paseo, workspaceId);
  const results = await Promise.allSettled([runScript(workspaceId, "ls").then(parseServices), discoverWorkspaceListeners(directory)]);
  const warnings: string[] = [];
  const services = results[0].status === "fulfilled" ? results[0].value : [];
  const listeners = results[1].status === "fulfilled" ? results[1].value : [];
  if (results[0].status === "rejected") warnings.push("Managed services unavailable. Check the Paseo CLI and daemon connection.");
  if (results[1].status === "rejected") warnings.push("Process discovery unavailable. Managed services may still be listed.");
  return { apps: appsFromProcesses(services, listeners), warnings };
}

export function appsFromProcesses(services: Service[], listeners: Listener[]): App[] {
  const managed: App[] = services.map((entry) => ({
    id: `managed:${entry.scriptName}`,
    name: entry.scriptName,
    source: "managed",
    status: entry.lifecycle,
    listening: entry.lifecycle === "running" && listeners.some(({ port }) => port === entry.port),
    port: entry.port,
    pid: null,
    scriptName: entry.scriptName,
    terminalId: entry.terminalId ?? null,
    targetHost: listeners.find(({ port }) => port === entry.port)?.targetHost ?? "127.0.0.1",
    detail: "Configured Paseo service",
  }));
  const managedPorts = new Set(managed.filter(({ status }) => status === "running").map(({ port }) => port));
  const detected: App[] = listeners.filter(({ port }) => !managedPorts.has(port)).map((entry) => ({
    id: `detected:${entry.pid}:${entry.port}`,
    name: entry.name,
    source: "detected",
    status: "running",
    listening: true,
    port: entry.port,
    pid: entry.pid,
    scriptName: null,
    terminalId: null,
    targetHost: entry.targetHost,
    detail: "Working directory is inside this workspace; agent ownership and HTTP support are unverified.",
  }));
  return [...managed, ...detected].sort((a, b) => a.name.localeCompare(b.name) || (a.port ?? 0) - (b.port ?? 0));
}

export async function controlApp(paseo: PaseoApi, workspaceId: string, scriptName: string, action: "start" | "stop"): Promise<void> {
  z.enum(["start", "stop"]).parse(action);
  await workspaceDirectory(paseo, workspaceId);
  await service(workspaceId, scriptName);
  validateServiceAction(await runScript(workspaceId, action, scriptName), scriptName, action);
}

export async function appLogs(paseo: PaseoApi, workspaceId: string, scriptName: string): Promise<string> {
  await workspaceDirectory(paseo, workspaceId);
  const entry = await service(workspaceId, scriptName);
  if (!entry.terminalId) throw new Error("No terminal is available for this service.");
  const terminals = await paseo.terminals.list({ workspaceId });
  if (!terminals.entries.some(({ id }) => id === entry.terminalId)) throw new Error("Service terminal is no longer available in this workspace.");
  const capture = await paseo.terminals.ref(entry.terminalId).capture({ start: -100, stripAnsi: true });
  return capture.lines.join("\n");
}
