import type { PluginTheme } from '@getpaseo/plugin';
import { getPaseoClient, useHosts, useRpc, useSettings, type PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { copyText, Icon, Modal, ScrollView, TextInput, useToast } from '@getpaseo/plugin/client/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { appLogsRpc, controlAppRpc, listAppsRpc, pairing, type App } from '#shared/contracts';
import { disconnectTunnel, listTunnels, openTunnel, type TunnelRequest, type TunnelState } from '#client/tunnels';
import { SetupModal } from '#client/setup';
import { appUrl, Btn, ErrorNote, errText, KV, StatusDot } from '#client/components';

type TunnelRecord = { request: TunnelRequest; state: TunnelState };

type Dialog =
  | { kind: 'setup' }
  | { kind: 'connect'; app: App; remotePort: number }
  | { kind: 'logs'; app: App }
  | { kind: 'details'; app: App }
  | { kind: 'stop'; app: App };

export function PortsPanel({ theme, host, layout, navigation, workspaceId }: PluginWorkspacePanelProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const hosts = useHosts();
  const listApps = useRpc(listAppsRpc);
  const controlApp = useRpc(controlAppRpc);
  const fetchLogs = useRpc(appLogsRpc);
  const settings = useSettings(pairing);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const pair = settings.status === 'ready' ? settings.values : null;
  const sameHostDirect = !!pair && pair.viewerHostId !== '' && pair.viewerHostId === host.id && pair.sshTarget === '';
  const tunnelMode = !!pair && pair.viewerHostId !== '' && !sameHostDirect && pair.sshTarget !== '' && pair.helperWorkspaceId !== '';
  const configured = sameHostDirect || tunnelMode;
  const openBrowser = navigation?.openBrowser;
  const viewerLabel = pair ? (hosts.find((h) => h.serverId === pair.viewerHostId)?.label ?? pair.viewerHostId) : '';

  const appsKey = ['paseo-ports', 'apps', host.id, workspaceId];
  const appsQuery = useQuery({
    queryKey: appsKey,
    queryFn: () => listApps({ workspaceId }),
    refetchInterval: 5000,
  });

  const tunnelsQuery = useQuery({
    queryKey: ['paseo-ports', 'tunnels', host.id, workspaceId, pair?.viewerHostId ?? '', pair?.helperWorkspaceId ?? ''],
    enabled: tunnelMode,
    retry: false,
    refetchInterval: 4000,
    queryFn: () => listTunnels(getPaseoClient(pair!.viewerHostId), pair!.helperWorkspaceId, host.id, workspaceId),
  });

  const apps = appsQuery.data?.apps ?? [];
  const tunnels: TunnelRecord[] = tunnelMode ? (tunnelsQuery.data ?? []) : [];
  const tunnelByApp = new Map<string, TunnelRecord>();
  for (const record of tunnels) if (!tunnelByApp.has(record.request.appId)) tunnelByApp.set(record.request.appId, record);

  // A recovered tunnel only belongs to the row when it still targets the app's current port and the saved alias.
  const matchesApp = (record: TunnelRecord, app: App) =>
    app.port !== null && record.request.remotePort === app.port &&
    record.request.targetHost === app.targetHost && !!pair && record.request.alias === pair.sshTarget;

  const s = useMemo(() => styles(theme, layout.compact), [theme, layout.compact]);

  function run(key: string, task: () => Promise<void>) {
    setBusyKey(key);
    void task()
      .catch((error) => toast.error(errText(error)))
      .finally(() => setBusyKey(null));
  }

  // shortcut: privileged remote ports map to 10000+port locally; add a smarter default if that collides routinely.
  const defaultLocalPort = (remote: number) => (remote >= 1024 ? remote : 10000 + remote);

  function buildRequest(app: App, remotePort: number, localPort: number): TunnelRequest {
    return {
      remoteServerId: host.id,
      workspaceId,
      appId: app.id,
      alias: pair!.sshTarget,
      localPort,
      remotePort,
      targetHost: app.targetHost,
      helperWorkspaceId: pair!.helperWorkspaceId,
    };
  }

  function openApp(app: App, remotePort: number) {
    if (!openBrowser || !pair) return;
    if (sameHostDirect) {
      openBrowser({ url: appUrl(app.targetHost, remotePort), workspaceId, serverId: host.id });
      return;
    }
    const record = tunnelByApp.get(app.id);
    if (record && matchesApp(record, app) && record.state.status === 'running') {
      openBrowser({ url: record.state.url, workspaceId, serverId: host.id });
      return;
    }
    if (record) {
      toast.error('A tunnel for this app already exists. Disconnect it before opening a new connection.');
      return;
    }
    setDialog({ kind: 'connect', app, remotePort });
  }

  async function connectAndOpen(app: App, remotePort: number, localPort: number) {
    const state = await openTunnel(getPaseoClient(pair!.viewerHostId), buildRequest(app, remotePort, localPort));
    await queryClient.invalidateQueries({ queryKey: ['paseo-ports', 'tunnels'] });
    openBrowser?.({ url: state.url, workspaceId, serverId: host.id });
  }

  function startAndOpen(app: App) {
    run(`start:${app.id}`, async () => {
      await controlApp({ workspaceId, scriptName: app.scriptName!, action: 'start' });
      const deadline = Date.now() + 15_000;
      let started: App | undefined;
      for (;;) {
        const { apps: fresh } = await listApps({ workspaceId });
        const match = fresh.find((a) => a.id === app.id || (a.scriptName !== null && a.scriptName === app.scriptName));
        if (match && match.status === 'running' && match.port !== null && match.listening) { started = match; break; }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      await queryClient.invalidateQueries({ queryKey: appsKey });
      if (!started || started.port === null) {
        throw new Error(`${app.name} was started, but no listening port was confirmed within 15 seconds. Check its logs.`);
      }
      if (openBrowser && configured) openApp(started, started.port);
    });
  }

  async function doStop(app: App) {
    await controlApp({ workspaceId, scriptName: app.scriptName!, action: 'stop' });
    await queryClient.invalidateQueries({ queryKey: appsKey });
  }

  function disconnect(record: TunnelRecord) {
    run(`disc:${record.state.terminalId}`, async () => {
      await disconnectTunnel(getPaseoClient(pair!.viewerHostId), record.request);
      await queryClient.invalidateQueries({ queryKey: ['paseo-ports', 'tunnels'] });
    });
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['paseo-ports'] }).catch(() => undefined);
  }

  function appStatus(app: App): { text: string; color: string } {
    if (app.status === 'running') return { text: 'Running', color: theme.colors.statusSuccess };
    if (app.status === 'stopped') return { text: 'Stopped', color: theme.colors.foregroundMuted };
    return { text: 'Unknown', color: theme.colors.statusWarning };
  }

  function tunnelCell(app: App): { text: string; color: string } {
    if (!configured) return { text: 'Not set up', color: theme.colors.foregroundMuted };
    if (sameHostDirect) return { text: 'Local app', color: theme.colors.foregroundMuted };
    if (tunnelsQuery.isError) return { text: 'Unknown', color: theme.colors.statusWarning };
    const record = tunnelByApp.get(app.id);
    if (!record) return { text: 'Not connected', color: theme.colors.foregroundMuted };
    if (!matchesApp(record, app)) return { text: 'Stale tunnel', color: theme.colors.statusWarning };
    if (record.state.status === 'running') return { text: `Connected · :${record.state.localPort}`, color: theme.colors.statusSuccess };
    if (record.state.status === 'connecting') return { text: 'Connecting…', color: theme.colors.statusWarning };
    return { text: 'Disconnected', color: theme.colors.statusDanger };
  }

  function primaryActions(app: App): ReactNode {
    const record = tunnelMode ? tunnelByApp.get(app.id) : undefined;
    if (app.source === 'managed' && app.status === 'stopped' && app.scriptName) {
      return (
        <Btn theme={theme} kind="primary" label={openBrowser && configured ? 'Start & Open' : 'Start'}
          busy={busyKey === `start:${app.id}`} onPress={() => startAndOpen(app)} />
      );
    }
    if (record && app.status === 'running' && !matchesApp(record, app)) {
      return (
        <Btn theme={theme} kind="danger" label="Disconnect" busy={busyKey === `disc:${record.state.terminalId}`}
          onPress={() => disconnect(record)} />
      );
    }
    if (app.status !== 'running') return null;
    if (record?.state.status === 'running') {
      return (
        <>
          <Btn theme={theme} kind="primary" label="Open app" disabled={!openBrowser}
            onPress={() => openApp(app, record.request.remotePort)} />
          <Btn theme={theme} label="Disconnect tunnel" busy={busyKey === `disc:${record.state.terminalId}`}
            onPress={() => disconnect(record)} />
        </>
      );
    }
    if (record?.state.status === 'connecting') {
      return <Btn theme={theme} label="Connecting…" disabled onPress={() => undefined} />;
    }
    if (record?.state.status === 'disconnected') {
      return (
        <Btn theme={theme} kind="danger" label="Disconnect" busy={busyKey === `disc:${record.state.terminalId}`}
          onPress={() => disconnect(record)} />
      );
    }
    if (app.port !== null && configured && openBrowser) {
      return (
        <Btn theme={theme} kind="primary" label={app.source === 'detected' ? 'Open in browser' : 'Open'}
          onPress={() => openApp(app, app.port!)} />
      );
    }
    return null;
  }

  function secondaryActions(app: App): ReactNode {
    return (
      <View style={s.actionRow}>
        <Btn theme={theme} small label="Details" onPress={() => setDialog({ kind: 'details', app })} />
        {app.source === 'managed' && app.scriptName ? (
          <>
            <Btn theme={theme} small label="Logs" onPress={() => setDialog({ kind: 'logs', app })} />
            {app.status === 'running' ? (
              <Btn theme={theme} small kind="danger" label="Stop app" onPress={() => setDialog({ kind: 'stop', app })} />
            ) : null}
          </>
        ) : null}
      </View>
    );
  }

  function renderRow(app: App) {
    const status = appStatus(app);
    const tunnel = tunnelCell(app);
    const record = tunnelMode ? tunnelByApp.get(app.id) : undefined;
    const disconnectedDetail = record && !matchesApp(record, app)
      ? 'This tunnel targets an old port or SSH target. Disconnect it before opening the app.'
      : record?.state.status === 'disconnected' ? record.state.detail : undefined;
    if (layout.compact) {
      return (
        <View key={app.id} style={s.card}>
          <View style={s.rowBetween}>
            <Text style={s.name}>{app.name}</Text>
            <Text style={s.mutedSmall}>{app.port !== null ? `:${app.port}` : '—'}</Text>
          </View>
          <View style={s.metaRow}>
            <StatusDot color={status.color} />
            <Text style={[s.mutedSmall, { color: status.color }]}>{status.text}</Text>
            <Text style={s.mutedSmall}>{app.source === 'managed' ? 'Managed' : 'Detected'}</Text>
            <Text style={[s.mutedSmall, { color: tunnel.color }]}>{tunnel.text}</Text>
          </View>
          {disconnectedDetail ? <ErrorNote theme={theme} text={disconnectedDetail} /> : null}
          <View style={s.actionRow}>{primaryActions(app)}</View>
          {secondaryActions(app)}
        </View>
      );
    }
    return (
      <View key={app.id} style={s.tableRow}>
        <View style={s.cells}>
          <Text style={[s.name, { flex: 2 }]} numberOfLines={1}>{app.name}</Text>
          <Text style={[s.cell, { flex: 0.9 }]}>{app.port !== null ? String(app.port) : '—'}</Text>
          <Text style={[s.cellMuted, { flex: 1 }]}>{app.source === 'managed' ? 'Managed' : 'Detected'}</Text>
          <View style={[s.metaRow, { flex: 1.2 }]}>
            <StatusDot color={status.color} />
            <Text style={[s.cell, { color: status.color }]}>{status.text}</Text>
          </View>
          <Text style={[s.cell, { flex: 1.6, color: tunnel.color }]} numberOfLines={1}>{tunnel.text}</Text>
          <View style={[s.actionRow, { flex: 2.6, justifyContent: 'flex-end' }]}>{primaryActions(app)}</View>
        </View>
        <View style={s.rowBetween}>
          {disconnectedDetail
            ? <View style={{ flexShrink: 1 }}><ErrorNote theme={theme} text={disconnectedDetail} /></View>
            : <View />}
          {secondaryActions(app)}
        </View>
      </View>
    );
  }

  const warnings = appsQuery.data?.warnings ?? [];

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <View style={s.header}>
        <View>
          <Text style={s.title}>Ports</Text>
          <Text style={s.subtitle}>Apps in this workspace</Text>
        </View>
        <View style={s.actionRow}>
          <Btn theme={theme} label="Refresh" icon="RefreshCw" onPress={refresh} />
          <Btn theme={theme} label="Connection settings" icon="Cable"
            disabled={settings.status === 'loading' || tunnels.length > 0} onPress={() => setDialog({ kind: 'setup' })} />
        </View>
      </View>

      {settings.status === 'loading' ? <Text style={s.muted}>Loading connection settings…</Text> : null}
      {settings.status === 'error' || settings.status === 'invalid' ? (
        <View style={s.noticeCard}>
          <ErrorNote theme={theme} text={`Connection settings unavailable: ${settings.error}`} />
          <Btn theme={theme} small label="Reload settings" onPress={() => void settings.reload().catch(() => undefined)} />
        </View>
      ) : null}

      {settings.status === 'ready' && !configured ? (
        <View style={s.noticeCard}>
          <Text style={s.name}>Connect this workspace to your Mac</Text>
          <Text style={s.muted}>
            Open apps running on {host.label} in a local browser through an SSH tunnel. Choose which Mac
            receives the tunnel and how SSH reaches this workspace’s Mac.
          </Text>
          <Btn theme={theme} kind="primary" label="Set up connection" onPress={() => setDialog({ kind: 'setup' })} />
        </View>
      ) : null}

      {configured ? (
        <View style={s.metaRow}>
          <Icon name={sameHostDirect ? 'Monitor' : 'Cable'} size={14} color={theme.colors.foregroundMuted} />
          <Text style={s.mutedSmall}>
            {sameHostDirect
              ? `Same Mac: apps open directly at localhost on ${viewerLabel}.`
              : `${host.label} → ${viewerLabel} via SSH “${pair!.sshTarget}”`}
          </Text>
        </View>
      ) : null}

      {tunnels.length > 0 ? (
        <Text style={s.mutedSmall}>Disconnect all tunnels below before changing connection settings.</Text>
      ) : null}

      {!openBrowser ? (
        <Text style={[s.mutedSmall, { color: theme.colors.statusWarning }]}>
          Opening apps locally requires the Paseo desktop app; app controls still work here.
        </Text>
      ) : null}
      {tunnelMode && tunnelsQuery.isError ? (
        <Text selectable style={[s.mutedSmall, { color: theme.colors.statusWarning }]}>
          {`Cannot reach ${viewerLabel} for tunnel status: ${errText(tunnelsQuery.error)}`}
        </Text>
      ) : null}
      {warnings.map((warning) => (
        <Text key={warning} selectable style={[s.mutedSmall, { color: theme.colors.statusWarning }]}>{warning}</Text>
      ))}

      {appsQuery.isPending ? <Text style={s.muted}>Loading apps…</Text> : null}
      {appsQuery.isError ? (
        <View style={s.noticeCard}>
          <ErrorNote theme={theme} text={`Could not list apps: ${errText(appsQuery.error)}`} />
          <Btn theme={theme} small label="Retry" onPress={() => void appsQuery.refetch()} />
        </View>
      ) : null}
      {appsQuery.isSuccess && apps.length === 0 ? (
        <View style={s.noticeCard}>
          <Text style={s.muted}>No apps found in this workspace.</Text>
          <Btn theme={theme} small label="Refresh" icon="RefreshCw" onPress={refresh} />
        </View>
      ) : null}

      {apps.length > 0 ? (
        <View style={s.table}>
          {!layout.compact ? (
            <View style={s.cells}>
              <Text style={[s.headCell, { flex: 2 }]}>Application</Text>
              <Text style={[s.headCell, { flex: 0.9 }]}>Port</Text>
              <Text style={[s.headCell, { flex: 1 }]}>Source</Text>
              <Text style={[s.headCell, { flex: 1.2 }]}>App status</Text>
              <Text style={[s.headCell, { flex: 1.6 }]}>Tunnel</Text>
              <Text style={[s.headCell, { flex: 2.6, textAlign: 'right' }]}>Action</Text>
            </View>
          ) : null}
          {apps.map(renderRow)}
        </View>
      ) : null}

      {tunnels.length > 0 ? (
        <View style={s.noticeCard}>
          <Text style={s.name}>Active tunnels</Text>
          <Text style={s.mutedSmall}>
            SSH tunnel terminals in the tunnel workspace, including ones whose app is no longer listed.
            Disconnecting never stops the remote app.
          </Text>
          {tunnels.map((record) => (
            <View key={record.state.terminalId} style={s.rowBetween}>
              <Text style={s.cell} numberOfLines={1}>
                {`${apps.find((app) => app.id === record.request.appId)?.name ?? record.request.appId} · :${record.request.localPort} → ${record.request.targetHost}:${record.request.remotePort}`}
              </Text>
              <View style={s.actionRow}>
                <Text style={[s.mutedSmall, {
                  color: record.state.status === 'running' ? theme.colors.statusSuccess
                    : record.state.status === 'connecting' ? theme.colors.statusWarning : theme.colors.statusDanger,
                }]}>
                  {record.state.status}
                </Text>
                <Btn theme={theme} small label="Disconnect" busy={busyKey === `disc:${record.state.terminalId}`}
                  onPress={() => disconnect(record)} />
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {apps.length > 0 ? (
        <Text style={s.mutedSmall}>
          Managed apps can be started and stopped here. Detected apps are matched to this workspace.
        </Text>
      ) : null}

      {dialog?.kind === 'setup' && settings.status === 'ready' ? (
        <SetupModal theme={theme} host={host} values={settings.values} revision={settings.revision}
          save={settings.save} saveError={settings.saveError} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'connect' && pair ? (
        <ConnectDialog theme={theme} app={dialog.app} remotePort={dialog.remotePort}
          defaultPort={defaultLocalPort(dialog.remotePort)} hostLabel={host.label}
          viewerLabel={viewerLabel} alias={pair.sshTarget}
          connect={(localPort) => connectAndOpen(dialog.app, dialog.remotePort, localPort)}
          onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'logs' ? (
        <LogsDialog theme={theme} app={dialog.app} platform={layout.platform}
          hostId={host.id} workspaceId={workspaceId}
          fetchText={() => fetchLogs({ workspaceId, scriptName: dialog.app.scriptName! })}
          onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'details' ? (
        <DetailsDialog theme={theme} app={dialog.app} record={tunnelByApp.get(dialog.app.id)}
          onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'stop' ? (
        <StopDialog theme={theme} app={dialog.app} hostLabel={host.label}
          stop={() => doStop(dialog.app)} onClose={() => setDialog(null)} />
      ) : null}
    </ScrollView>
  );
}

function ConnectDialog({ theme, app, remotePort, defaultPort, hostLabel, viewerLabel, alias, connect, onClose }: {
  theme: PluginTheme;
  app: App;
  remotePort: number;
  defaultPort: number;
  hostLabel: string;
  viewerLabel: string;
  alias: string;
  connect: (localPort: number) => Promise<void>;
  onClose: () => void;
}) {
  const [portText, setPortText] = useState(String(defaultPort));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const port = Number(portText.trim());
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setError('Local port must be a whole number from 1024 to 65535.');
      return;
    }
    setBusy(true);
    setError(null);
    connect(port)
      .then(onClose)
      .catch((cause) => { setError(errText(cause)); setBusy(false); });
  }

  return (
    <Modal title={`Open ${app.name}?`} open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
          Create a local SSH connection on {viewerLabel} to port {remotePort} on {hostLabel}, then open it in a browser.
        </Text>
        <KV theme={theme} label={`Local port on ${viewerLabel}`}>
          <PortInput theme={theme} value={portText} onChange={(next) => { setPortText(next); setError(null); }} disabled={busy} />
        </KV>
        <KV theme={theme} label="Remote destination" value={`${app.targetHost}:${remotePort} on ${hostLabel}`} />
        <KV theme={theme} label="SSH target" value={alias} />
        {error ? <ErrorNote theme={theme} text={error} /> : null}
        {error ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            If the local port is already in use, choose another port and try again.
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
          <Btn theme={theme} label="Cancel" disabled={busy} onPress={onClose} />
          <Btn theme={theme} kind="primary" label="Connect & Open" busy={busy} onPress={submit} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

function PortInput({ theme, value, onChange, disabled }: {
  theme: PluginTheme;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      editable={!disabled}
      keyboardType="number-pad"
      autoCorrect={false}
      style={{
        borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, minWidth: 90,
        paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, textAlign: 'right',
        color: theme.colors.foreground, backgroundColor: theme.colors.surface2,
      }}
    />
  );
}

function LogsDialog({ theme, app, platform, hostId, workspaceId, fetchText, onClose }: {
  theme: PluginTheme;
  app: App;
  platform: 'ios' | 'android' | 'web';
  hostId: string;
  workspaceId: string;
  fetchText: () => Promise<{ text: string }>;
  onClose: () => void;
}) {
  const logsQuery = useQuery({
    queryKey: ['paseo-ports', 'logs', hostId, workspaceId, app.terminalId ?? app.id],
    queryFn: fetchText,
    retry: false,
  });
  return (
    <Modal title={`${app.name} logs`} open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }}>
        {logsQuery.isPending ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, padding: 16 }}>Loading logs…</Text>
        ) : logsQuery.isError ? (
          <View style={{ padding: 16, gap: 8 }}>
            <ErrorNote theme={theme} text={errText(logsQuery.error)} />
            <Btn theme={theme} small label="Retry" onPress={() => void logsQuery.refetch()} />
          </View>
        ) : (
          <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 16 }}>
            <Text selectable style={{
              color: theme.colors.foreground, fontSize: 12, lineHeight: 17,
              fontFamily: platform === 'ios' ? 'Menlo' : 'monospace',
            }}>
              {logsQuery.data.text || 'No output.'}
            </Text>
          </ScrollView>
        )}
      </Modal.Content>
    </Modal>
  );
}

function DetailsDialog({ theme, app, record, onClose }: {
  theme: PluginTheme;
  app: App;
  record: TunnelRecord | undefined;
  onClose: () => void;
}) {
  const toast = useToast();
  return (
    <Modal title={app.name} open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Content>
        <KV theme={theme} label="Source" value={app.source === 'managed' ? 'Managed script' : 'Detected listener'} />
        <KV theme={theme} label="App status" value={app.status} />
        <KV theme={theme} label="Port" value={app.port !== null ? String(app.port) : 'Not listening'} />
        <KV theme={theme} label="PID" value={app.pid !== null ? String(app.pid) : '—'} />
        <KV theme={theme} label="Destination" value={app.port !== null ? `${app.targetHost}:${app.port}` : app.targetHost} />
        {app.detail ? (
          <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{app.detail}</Text>
        ) : null}
        {record ? <KV theme={theme} label="Tunnel" value={`${record.state.status} · local :${record.state.localPort}`} /> : null}
        {record?.state.status === 'running' ? (
          <Btn theme={theme} small label="Copy local URL" icon="Copy" onPress={() => {
            void copyText(record.state.url)
              .then(() => toast.show('Copied', { variant: 'success' }))
              .catch(() => toast.error('Could not copy. Select the text and use Copy.'));
          }} />
        ) : null}
        {app.source === 'detected' ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
            Detected by scanning listeners on the workspace host. It is not managed by this workspace, so it
            cannot be started or stopped here, and the match to this workspace may be imperfect. Opening a
            port that is not a known HTTP server is your call — the browser simply connects to it.
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Btn theme={theme} label="Close" onPress={onClose} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

function StopDialog({ theme, app, hostLabel, stop, onClose }: {
  theme: PluginTheme;
  app: App;
  hostLabel: string;
  stop: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setBusy(true);
    setError(null);
    stop()
      .then(onClose)
      .catch((cause) => { setError(errText(cause)); setBusy(false); });
  }

  return (
    <Modal title={`Stop ${app.name}?`} open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
          Stops the managed script on {hostLabel}. Open tunnels are left in place and can be disconnected separately.
        </Text>
        {error ? <ErrorNote theme={theme} text={error} /> : null}
        <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
          <Btn theme={theme} label="Cancel" disabled={busy} onPress={onClose} />
          <Btn theme={theme} kind="danger" label="Stop app" busy={busy} onPress={submit} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

function styles(theme: PluginTheme, compact: boolean) {
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: compact ? 12 : 20, gap: 12 },
    header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
    title: { color: theme.colors.foreground, fontSize: 20, fontWeight: '700' },
    subtitle: { color: theme.colors.foregroundMuted, fontSize: 13 },
    muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
    mutedSmall: { color: theme.colors.foregroundMuted, fontSize: 12 },
    name: { color: theme.colors.foreground, fontSize: 14, fontWeight: '600' },
    cell: { color: theme.colors.foreground, fontSize: 13 },
    cellMuted: { color: theme.colors.foregroundMuted, fontSize: 13 },
    headCell: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase' as const, letterSpacing: 0.4 },
    table: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 12, gap: 10, backgroundColor: theme.colors.surface1 },
    tableRow: { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 10, gap: 6 },
    cells: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    card: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 12, gap: 8, backgroundColor: theme.colors.surface1 },
    noticeCard: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 12, gap: 8, backgroundColor: theme.colors.surface1 },
    rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    actionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  } as const;
}
