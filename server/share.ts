import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { PaseoApi, PaseoTerminal, PaseoTerminalHandle } from "@getpaseo/client";
import { z } from "zod";
import type { ServeMapping, Share, ShareAvailability } from "#shared/contracts";
import { findExecutable, identifier, listApps, workspaceDirectory } from "#server/apps";

const execute = promisify(execFile);
const port = z.number().int().min(1).max(65535);
const NAME_PREFIX = "Paseo Ports share v1 ";
const START_TIMEOUT_SECONDS = 15;
const BUNDLED_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

// Foreground serve: the mapping lives exactly as long as this process (verified for TERM, HUP and KILL).
// Never add --bg, funnel, reset, or an `off` cleanup: `off` could remove a mapping this share did not create.
export const SHARE_SCRIPT = String.raw`
set -u
printf '\nPASEO_PORTS_SHARE_START %s\n' "$(/bin/date +%s)"
"$1" serve --yes --https="$2" "http://127.0.0.1:$3"
printf '\nPASEO_PORTS_SHARE_EXIT\n'
`;

export function tailscaleCommand(environment: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = environment.PASEO_PORTS_TAILSCALE_CLI;
  if (explicit) return isAbsolute(explicit) ? explicit : null;
  return findExecutable("tailscale", process.platform === "darwin" ? [BUNDLED_CLI] : [], environment);
}

async function tailscale(cli: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execute(cli, args, { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim().split("\n")[0];
    throw new Error(`Tailscale command failed${stderr ? `: ${stderr.slice(0, 200)}` : "."}`);
  }
}

const unavailable = (reason: Exclude<ShareAvailability, { ok: true }>["reason"], message: string): ShareAvailability =>
  ({ ok: false, reason, message });

const statusSchema = z.object({
  BackendState: z.string(),
  Self: z.object({ DNSName: z.string() }).nullish(),
  CertDomains: z.array(z.string()).nullish(),
});

export function parseAvailability(output: string): ShareAvailability {
  const status = statusSchema.parse(JSON.parse(output));
  if (status.BackendState === "NeedsLogin" || status.BackendState === "NoState") {
    return unavailable("logged-out", "Tailscale is signed out on the workspace Mac.");
  }
  if (status.BackendState !== "Running") return unavailable("not-running", "Tailscale isn't connected on the workspace Mac.");
  const dnsName = (status.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dnsName) || !(status.CertDomains ?? []).includes(dnsName)) {
    return unavailable("https-disabled", "Enable MagicDNS and HTTPS certificates for your tailnet in the Tailscale admin console.");
  }
  return { ok: true, dnsName };
}

const serveConfig = z.object({
  TCP: z.record(z.string(), z.unknown()).nullish(),
  Web: z.record(z.string(), z.object({
    Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() })).nullish(),
  })).nullish(),
});
const serveStatus = serveConfig.extend({ Foreground: z.record(z.string(), serveConfig).nullish() });

/** Every served port, from background config and each foreground session. Non-proxy handlers get a descriptive target. */
export function parseServeMappings(output: string): ServeMapping[] {
  const status = serveStatus.parse(JSON.parse(output));
  return [status, ...Object.values(status.Foreground ?? {})].flatMap((config) =>
    Object.keys(config.TCP ?? {}).flatMap((key) => {
      const httpsPort = Number(key);
      if (!port.safeParse(httpsPort).success) return [];
      const web = Object.entries(config.Web ?? {}).find(([hostPort]) => hostPort.endsWith(`:${key}`))?.[1];
      return [{ httpsPort, target: web?.Handlers?.["/"]?.Proxy ?? "another Tailscale handler" }];
    }));
}

interface ShareRecord { entry: PaseoTerminal; appId: string; appPort: number; httpsPort: number }

export function shareName(workspaceId: string, appId: string, appPort: number, httpsPort: number): string {
  identifier.parse(workspaceId);
  identifier.parse(appId);
  port.parse(appPort);
  port.parse(httpsPort);
  return `${NAME_PREFIX}${JSON.stringify([workspaceId, appId, appPort, httpsPort])}`;
}

/** Owned only when the name round-trips exactly and the terminal belongs to this workspace. */
export function parseShareName(entry: PaseoTerminal, workspaceId: string): ShareRecord | null {
  if (entry.workspaceId !== workspaceId || !entry.name.startsWith(NAME_PREFIX)) return null;
  try {
    const parsed = z.tuple([z.literal(workspaceId), identifier, port, port]).safeParse(JSON.parse(entry.name.slice(NAME_PREFIX.length)));
    if (!parsed.success) return null;
    const [, appId, appPort, httpsPort] = parsed.data;
    return shareName(workspaceId, appId, appPort, httpsPort) === entry.name ? { entry, appId, appPort, httpsPort } : null;
  } catch { return null; }
}

/** `createdAt` (epoch seconds) covers a terminal this call just created, before its shell prints the start marker. */
async function readShare(
  terminal: PaseoTerminalHandle, record: Omit<ShareRecord, "entry">, mappings: ServeMapping[] | null, dnsName: string | null,
  createdAt?: number,
): Promise<Share> {
  const { lines } = await terminal.capture({ start: -60, stripAnsi: true });
  const output = lines.join("\n");
  const started = [...output.matchAll(/^PASEO_PORTS_SHARE_START (\d+)\s*$/gm)].at(-1);
  const exited = /^PASEO_PORTS_SHARE_EXIT\s*$/m.test(output);
  const mapped = mappings?.some(({ httpsPort, target }) =>
    httpsPort === record.httpsPort && target === `http://127.0.0.1:${record.appPort}`) ?? false;
  const startedAt = started ? Number(started[1]) : createdAt;
  const young = startedAt !== undefined && Date.now() / 1000 - startedAt < START_TIMEOUT_SECONDS;
  const status = exited ? "failed" : mapped ? "running" : young ? "starting" : "failed";
  const errorLines = lines.filter((line) => line.trim() && !line.startsWith("PASEO_PORTS_")).slice(-6).join("\n").slice(-600);
  return {
    terminalId: terminal.id,
    appId: record.appId,
    appPort: record.appPort,
    httpsPort: record.httpsPort,
    url: dnsName ? `https://${dnsName}:${record.httpsPort}` : "",
    status,
    detail: status === "failed" ? `Tailscale Serve is not running.${errorLines ? ` ${errorLines}` : ""}` : undefined,
  };
}

async function ownedShares(paseo: PaseoApi, workspaceId: string): Promise<ShareRecord[]> {
  const { entries } = await paseo.terminals.list({ workspaceId });
  return entries.flatMap((entry) => parseShareName(entry, workspaceId) ?? []);
}

export async function listShares(paseo: PaseoApi, workspaceId: string): Promise<{
  availability: ShareAvailability; shares: Share[]; foreign: ServeMapping[];
}> {
  await workspaceDirectory(paseo, workspaceId);
  const cli = tailscaleCommand();
  let availability = unavailable("not-installed", "Tailscale isn't installed on the workspace Mac.");
  let mappings: ServeMapping[] | null = null;
  if (cli) {
    try {
      availability = parseAvailability(await tailscale(cli, ["status", "--json"]));
      if (availability.ok) mappings = parseServeMappings(await tailscale(cli, ["serve", "status", "--json"]));
    } catch (error) {
      availability = unavailable("unknown", error instanceof Error ? error.message : String(error));
    }
  }
  const dnsName = availability.ok ? availability.dnsName : null;
  const shares = await Promise.all((await ownedShares(paseo, workspaceId)).map((record) =>
    readShare(paseo.terminals.ref(record.entry), record, mappings, dnsName)));
  const running = new Set(shares.filter(({ status }) => status === "running").map(({ httpsPort }) => httpsPort));
  return { availability, shares, foreign: (mappings ?? []).filter(({ httpsPort }) => !running.has(httpsPort)) };
}

// Serve ports are host-wide, so in-flight starts are serialized per HTTPS port across workspaces and apps.
const pending = new Map<number, { owner: string; share: Promise<Share> }>();

export function startShare(
  paseo: PaseoApi, workspaceId: string, appId: string, httpsPort: number, apps: typeof listApps = listApps,
): Promise<Share> {
  identifier.parse(workspaceId);
  identifier.parse(appId);
  port.parse(httpsPort);
  const owner = JSON.stringify([workspaceId, appId]);
  const current = pending.get(httpsPort);
  if (current) {
    if (current.owner === owner) return current.share;
    return Promise.reject(new Error(`Port ${httpsPort} is already being shared. Choose another HTTPS port.`));
  }
  const share = createShare(paseo, workspaceId, appId, httpsPort, apps).finally(() => pending.delete(httpsPort));
  pending.set(httpsPort, { owner, share });
  return share;
}

async function createShare(
  paseo: PaseoApi, workspaceId: string, appId: string, httpsPort: number, apps: typeof listApps,
): Promise<Share> {
  const cli = tailscaleCommand();
  if (!cli) throw new Error("Tailscale isn't installed on the workspace Mac.");
  const availability = parseAvailability(await tailscale(cli, ["status", "--json"]));
  if (!availability.ok) throw new Error(availability.message);
  const app = (await apps(paseo, workspaceId)).apps.find(({ id }) => id === appId);
  if (!app || app.status !== "running" || !app.listening || app.port === null) throw new Error("This app isn't listening. Start it first.");
  if (app.targetHost !== "127.0.0.1") throw new Error("Not shareable: Tailscale Serve proxies IPv4 loopback only.");
  const record = { appId, appPort: app.port, httpsPort };
  const name = shareName(workspaceId, appId, app.port, httpsPort);
  const owned = await ownedShares(paseo, workspaceId);
  const same = owned.filter(({ entry }) => entry.name === name);
  if (same.length > 1) throw new Error(`Multiple share terminals exist for port ${httpsPort}. Close the duplicates in this workspace.`);

  let terminal: PaseoTerminalHandle;
  let createdAt: number | undefined;
  if (same.length === 1) {
    terminal = paseo.terminals.ref(same[0].entry);
    const mappings = parseServeMappings(await tailscale(cli, ["serve", "status", "--json"]));
    const existing = await readShare(terminal, record, mappings, availability.dnsName);
    if (existing.status === "running") return existing;
    if (existing.status === "failed") throw new Error("An old share terminal for this app exists. Stop sharing before sharing again.");
  } else {
    if (owned.some((share) => share.httpsPort === httpsPort)) {
      throw new Error(`Port ${httpsPort} is already shared from this workspace. Choose another HTTPS port.`);
    }
    if (parseServeMappings(await tailscale(cli, ["serve", "status", "--json"])).some((mapping) => mapping.httpsPort === httpsPort)) {
      throw new Error(`Port ${httpsPort} is already served by Tailscale on the workspace Mac. Choose another HTTPS port.`);
    }
    terminal = await paseo.terminals.create({
      workspaceId, name, command: "/bin/sh",
      args: ["-c", SHARE_SCRIPT, "paseo-ports-share", cli, String(httpsPort), String(app.port)],
      size: { rows: 24, cols: 100 },
    });
    createdAt = Date.now() / 1000;
  }
  try {
    const deadline = Date.now() + (START_TIMEOUT_SECONDS + 2) * 1000;
    for (;;) {
      const mappings = parseServeMappings(await tailscale(cli, ["serve", "status", "--json"]));
      const share = await readShare(terminal, record, mappings, availability.dnsName, createdAt);
      if (share.status === "running") return share;
      if (share.status === "failed") throw new Error(share.detail);
      if (Date.now() >= deadline) throw new Error(`Tailscale Serve did not start within ${START_TIMEOUT_SECONDS} seconds.`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    if (createdAt !== undefined) {
      try { await terminal.kill(); }
      catch { throw new Error(`${error instanceof Error ? error.message : String(error)} Cleanup failed; close the share terminal in this workspace.`); }
    }
    throw error;
  }
}

export async function stopShare(paseo: PaseoApi, workspaceId: string, terminalId: string): Promise<void> {
  identifier.parse(terminalId);
  await workspaceDirectory(paseo, workspaceId);
  const { entries } = await paseo.terminals.list({ workspaceId });
  const entry = entries.find(({ id }) => id === terminalId);
  if (!entry) return; // Already gone: nothing is being shared through it.
  const record = parseShareName(entry, workspaceId);
  if (!record) throw new Error("This terminal is not a Workspace Ports share.");
  // Serialize with startup so a late create cannot leave an orphan share.
  await pending.get(record.httpsPort)?.share.catch(() => undefined);
  await paseo.terminals.ref(entry).kill();
}
