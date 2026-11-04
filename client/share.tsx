import type { PluginTheme } from '@getpaseo/plugin';
import { Modal } from '@getpaseo/plugin/client/ui';
import { useState } from 'react';
import { Text, View } from 'react-native';
import type { App, ServeMapping, Share } from '#shared/contracts';
import { Btn, ErrorNote, errText, KV, PortInput } from '#client/components';

/** Tailscale Serve proxies only http://127.0.0.1, so IPv6-only listeners cannot be shared. */
export const shareable = (app: App): boolean =>
  app.status === 'running' && app.listening && app.port !== null && app.targetHost === '127.0.0.1';

export function shareCell(theme: PluginTheme, share: Share | undefined): { text: string; color: string } {
  if (!share) return { text: 'Not shared', color: theme.colors.foregroundMuted };
  if (share.status === 'running') return { text: `Shared · :${share.httpsPort}`, color: theme.colors.statusSuccess };
  if (share.status === 'starting') return { text: 'Starting…', color: theme.colors.statusWarning };
  return { text: 'Failed', color: theme.colors.statusDanger };
}

const card = (theme: PluginTheme) => ({
  borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 12, gap: 8, backgroundColor: theme.colors.surface1,
}) as const;

export function ShareDialog({ theme, app, hostLabel, dnsName, share, onClose }: {
  theme: PluginTheme;
  app: App;
  hostLabel: string;
  dnsName: string;
  share: (httpsPort: number, open: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [portText, setPortText] = useState(String(app.port ?? ''));
  const [busy, setBusy] = useState<'share' | 'open' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const port = Number(portText.trim());
  const valid = Number.isInteger(port) && port >= 1 && port <= 65535;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 } as const;

  function submit(open: boolean) {
    if (!valid) { setError('HTTPS port must be a whole number from 1 to 65535.'); return; }
    setBusy(open ? 'open' : 'share');
    setError(null);
    share(port, open)
      .then(onClose)
      .catch((cause) => { setError(errText(cause)); setBusy(null); });
  }

  return (
    <Modal title={`Share ${app.name} to your tailnet?`} open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Content>
        <KV theme={theme} label="Link" value={`https://${dnsName}:${valid ? port : '…'}`} />
        <KV theme={theme} label="HTTPS port">
          <PortInput theme={theme} value={portText} onChange={(next) => { setPortText(next); setError(null); }} disabled={!!busy} />
        </KV>
        <KV theme={theme} label="Destination" value={`127.0.0.1:${app.port} on ${hostLabel}`} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
          Reachable by devices in your tailnet that your ACLs allow. Not public. This is not app authentication.
        </Text>
        <Text style={muted}>
          The first open on a Mac can take up to a minute while Tailscale issues its HTTPS certificate. Dev servers may
          reject unknown hostnames; allow *.ts.net (for example Vite server.allowedHosts).
        </Text>
        {error ? <ErrorNote theme={theme} text={error} /> : null}
        <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Btn theme={theme} label="Cancel" disabled={!!busy} onPress={onClose} />
          <Btn theme={theme} label="Share" busy={busy === 'share'} disabled={busy === 'open'} onPress={() => submit(false)} />
          <Btn theme={theme} kind="primary" label="Share & Open" busy={busy === 'open'} disabled={busy === 'share'}
            onPress={() => submit(true)} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

export function ActiveSharesCard({ theme, shares, foreign, appName, busyKey, onStop }: {
  theme: PluginTheme;
  shares: Share[];
  foreign: ServeMapping[];
  appName: (appId: string) => string;
  busyKey: string | null;
  onStop: (share: Share) => void;
}) {
  const small = { color: theme.colors.foregroundMuted, fontSize: 12 } as const;
  const row = { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } as const;
  return (
    <View style={card(theme)}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: '600' }}>Active shares</Text>
      <Text style={small}>
        Tailscale Serve shares created from this workspace, including ones whose app is no longer listed.
        Stopping a share never stops the app.
      </Text>
      {shares.map((share) => {
        const cell = shareCell(theme, share);
        return (
          <View key={share.terminalId} style={{ gap: 4 }}>
            <View style={row}>
              <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, flexShrink: 1 }}>
                {`${appName(share.appId)} · ${share.url || `:${share.httpsPort}`} → 127.0.0.1:${share.appPort}`}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={[small, { color: cell.color }]}>{share.status}</Text>
                <Btn theme={theme} small label="Stop sharing" busy={busyKey === `unshare:${share.terminalId}`}
                  onPress={() => onStop(share)} />
              </View>
            </View>
            {share.status === 'failed' && share.detail ? <ErrorNote theme={theme} text={share.detail} /> : null}
          </View>
        );
      })}
      {foreign.map((mapping) => (
        <View key={`foreign:${mapping.httpsPort}`} style={{ gap: 2 }}>
          <Text selectable style={{ color: theme.colors.foreground, fontSize: 13 }}>
            {`:${mapping.httpsPort} → ${mapping.target}`}
          </Text>
          <Text selectable style={small}>
            {`Shared outside this workspace's controls. To remove it, run: tailscale serve --https=${mapping.httpsPort} off`}
          </Text>
        </View>
      ))}
    </View>
  );
}
