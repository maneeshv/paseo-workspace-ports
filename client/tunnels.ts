import type { PaseoApi, PaseoTerminalHandle } from "@getpaseo/client";

export interface TunnelRequest {
  remoteServerId: string;
  workspaceId: string;
  appId: string;
  alias: string;
  localPort: number;
  remotePort: number;
  targetHost: "127.0.0.1" | "::1";
  helperWorkspaceId: string;
}

export interface TunnelState {
  terminalId: string;
  localPort: number;
  url: string;
  status: "running" | "connecting" | "disconnected";
  detail?: string;
}

// The only variable shell inputs are positional arguments, never source text.
export const TUNNEL_SCRIPT = String.raw`
set -u
umask 077
dir=$(/usr/bin/mktemp -d /tmp/paseo-ports.XXXXXXXX) || exit 1
sock="$dir/control"
ssh_pid=
cleanup() {
  trap '' HUP INT TERM
  if [ -n "$ssh_pid" ]; then
    /usr/bin/ssh -F /dev/null -S "$sock" -O exit "$1" >/dev/null 2>&1 || kill "$ssh_pid" 2>/dev/null || :
    wait "$ssh_pid" 2>/dev/null || :
  fi
  printf '\nPASEO_PORTS_EXIT\n'
  /usr/bin/trash "$dir" >/dev/null 2>&1 || :
}
trap 'exit 130' HUP INT TERM
trap 'cleanup "$1"' EXIT
/usr/bin/ssh -N -T -n -a -x -M -S "$sock" \
  -o ControlPersist=no -o ForkAfterAuthentication=no -o ClearAllForwardings=yes \
  -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes \
  -o PermitLocalCommand=no -o RemoteCommand=none -o RequestTTY=no -o Tunnel=no -o GatewayPorts=no \
  -o ConnectTimeout=10 -o ConnectionAttempts=1 \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=2 "$1" </dev/null &
ssh_pid=$!
attempt=0
while ! /usr/bin/ssh -F /dev/null -S "$sock" -O check "$1" >/dev/null 2>&1; do
  if ! kill -0 "$ssh_pid" 2>/dev/null; then exit 1; fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 15 ]; then echo 'SSH connection timed out.'; exit 1; fi
  /bin/sleep 1
done
# Clear inherited forwards on the master; add exactly one through its private socket.
/usr/bin/ssh -F /dev/null -S "$sock" -O forward -o ExitOnForwardFailure=yes \
  -L "127.0.0.1:$2:$3:$4" "$1" </dev/null || exit 1
while /usr/bin/ssh -F /dev/null -S "$sock" -O check "$1" >/dev/null 2>&1; do
  printf '\nPASEO_PORTS_READY %s\n' "$(/bin/date +%s)"
  /bin/sleep 5
done
wait "$ssh_pid" 2>/dev/null || :
ssh_pid=
`;

function validate(request: TunnelRequest): void {
  if (request.alias.length > 253 || !/^(?:[a-zA-Z_][a-zA-Z0-9._-]*@)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(request.alias)) {
    throw new Error("Choose an SSH config alias, optionally prefixed with user@ (letters, numbers, dots, dashes or underscores).");
  }
  for (const port of [request.localPort, request.remotePort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Ports must be integers from 1 to 65535.");
  }
  if (request.localPort < 1024) throw new Error("Local ports must be at least 1024.");
  if (request.targetHost !== "127.0.0.1" && request.targetHost !== "::1") {
    throw new Error("The destination must be a loopback address on the workspace host.");
  }
  for (const id of [request.remoteServerId, request.workspaceId, request.appId, request.helperWorkspaceId]) {
    if (!id || id.length > 512 || /[\x00-\x1f\x7f]/.test(id)) throw new Error("Missing or invalid workspace/application identity.");
  }
}

export function tunnelName(request: TunnelRequest): string {
  validate(request);
  return `Paseo Ports v1 ${JSON.stringify([
    request.remoteServerId, request.workspaceId, request.appId,
    request.alias, request.localPort, request.targetHost, request.remotePort,
  ])}`;
}

async function findTerminal(paseo: PaseoApi, request: TunnelRequest): Promise<PaseoTerminalHandle | null> {
  const name = tunnelName(request);
  const { entries } = await paseo.terminals.list({ workspaceId: request.helperWorkspaceId });
  const matching = entries.filter((entry) => entry.name === name && entry.workspaceId === request.helperWorkspaceId);
  if (matching.length > 1) throw new Error("Multiple matching tunnel terminals exist. Close the duplicates in the helper workspace first.");
  return matching[0] ? paseo.terminals.ref(matching[0]) : null;
}

async function readState(terminal: PaseoTerminalHandle, request: TunnelRequest): Promise<TunnelState> {
  const { lines } = await terminal.capture({ start: -60, stripAnsi: true });
  const output = lines.join("\n");
  const ready = [...output.matchAll(/^PASEO_PORTS_READY (\d+)\s*$/gm)].at(-1);
  const exited = /^PASEO_PORTS_EXIT\s*$/m.test(output);
  // shortcut: heartbeat assumes the two Macs' clocks agree; replace if supporting unsynchronised hosts.
  const recent = ready && Math.abs(Date.now() / 1000 - Number(ready[1])) < 20;
  const status = exited || (ready && !recent) ? "disconnected" : recent ? "running" : "connecting";
  const errorLines = lines.filter((line) => line.trim() && !line.startsWith("PASEO_PORTS_")).slice(-6).join("\n").slice(-600);
  const detail = status === "disconnected"
    ? (exited ? `SSH exited.${errorLines ? ` ${errorLines}` : " Check key authentication, the SSH target and local port."}` : "No recent SSH heartbeat. Check the helper terminal before reconnecting.")
    : undefined;
  return { terminalId: terminal.id, localPort: request.localPort, url: `http://127.0.0.1:${request.localPort}`, status, detail };
}

export async function inspectTunnel(paseo: PaseoApi, request: TunnelRequest): Promise<TunnelState | null> {
  const terminal = await findTerminal(paseo, request);
  return terminal ? readState(terminal, request) : null;
}

export async function listTunnels(
  paseo: PaseoApi, helperWorkspaceId: string, remoteServerId: string, workspaceId: string,
): Promise<{ request: TunnelRequest; state: TunnelState }[]> {
  const { entries } = await paseo.terminals.list({ workspaceId: helperWorkspaceId });
  const owned = entries.flatMap((entry) => {
    if (entry.workspaceId !== helperWorkspaceId || !entry.name.startsWith("Paseo Ports v1 ")) return [];
    try {
      const data: unknown = JSON.parse(entry.name.slice("Paseo Ports v1 ".length));
      if (!Array.isArray(data) || data.length !== 7) return [];
      const [server, workspace, appId, alias, localPort, targetHost, remotePort] = data;
      if (server !== remoteServerId || workspace !== workspaceId ||
        typeof appId !== "string" || typeof alias !== "string" ||
        typeof localPort !== "number" || typeof remotePort !== "number" ||
        (targetHost !== "127.0.0.1" && targetHost !== "::1")) return [];
      const request: TunnelRequest = { remoteServerId, workspaceId, appId, alias, localPort, targetHost, remotePort, helperWorkspaceId };
      if (tunnelName(request) !== entry.name) return [];
      return [{ request, terminal: paseo.terminals.ref(entry) }];
    } catch { return []; }
  });
  return Promise.all(owned.map(async ({ request, terminal }) => ({ request, state: await readState(terminal, request) })));
}

const pending = new Map<string, Promise<TunnelState>>();

export function openTunnel(paseo: PaseoApi, request: TunnelRequest): Promise<TunnelState> {
  const key = `${request.helperWorkspaceId}:${tunnelName(request)}`;
  const current = pending.get(key);
  if (current) return current;
  const opening = startTunnel(paseo, request).finally(() => pending.delete(key));
  pending.set(key, opening);
  return opening;
}

async function startTunnel(paseo: PaseoApi, request: TunnelRequest): Promise<TunnelState> {
  let terminal = await findTerminal(paseo, request);
  let created = false;
  if (terminal) {
    const state = await readState(terminal, request);
    if (state.status === "running") return state;
    if (state.status === "disconnected") {
      throw new Error("An old tunnel terminal exists. Disconnect it before opening a new tunnel.");
    }
  } else {
    terminal = await paseo.terminals.create({
      workspaceId: request.helperWorkspaceId,
      name: tunnelName(request),
      command: "/bin/sh",
      args: ["-c", TUNNEL_SCRIPT, "paseo-ports", request.alias, String(request.localPort),
        request.targetHost === "::1" ? "[::1]" : request.targetHost, String(request.remotePort)],
      size: { rows: 30, cols: 120 },
    });
    created = true;
  }
  try {
    const deadline = Date.now() + 18_000;
    do {
      const state = await readState(terminal, request);
      if (state.status === "running") return state;
      if (state.status === "disconnected") throw new Error(state.detail);
      await new Promise((resolve) => setTimeout(resolve, 300));
    } while (Date.now() < deadline);
    throw new Error("SSH did not become ready within 18 seconds. Check key authentication, the saved alias, and the local port.");
  } catch (error) {
    if (created) {
      try { await terminal.kill(); }
      catch { throw new Error(`${error instanceof Error ? error.message : String(error)} Cleanup failed; close the tunnel terminal in the helper workspace.`); }
    }
    throw error;
  }
}

export async function disconnectTunnel(paseo: PaseoApi, request: TunnelRequest): Promise<void> {
  const key = `${request.helperWorkspaceId}:${tunnelName(request)}`;
  // Serialize disconnect with startup so a late create cannot leave an orphan tunnel.
  await pending.get(key)?.catch(() => undefined);
  const terminal = await findTerminal(paseo, request);
  if (terminal) await terminal.kill();
}
