import type { PluginTheme } from '@getpaseo/plugin';
import { getPaseoClient, useHosts } from '@getpaseo/plugin/client';
import { Icon, Modal, SettingsSelect, TextInput, useToast } from '@getpaseo/plugin/client/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import type { Pairing } from '#shared/contracts';
import { Btn, ErrorNote, errText } from '#client/components';

export function SetupModal({ theme, host, values, revision, save, saveError, onClose }: {
  theme: PluginTheme;
  host: { id: string; label: string };
  values: Pairing;
  revision: string;
  save: (values: Pairing, revision: string) => Promise<boolean>;
  saveError: string | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const hosts = useHosts();
  const [viewerHostId, setViewerHostId] = useState(values.viewerHostId);
  const [helperWorkspaceId, setHelperWorkspaceId] = useState(values.helperWorkspaceId);
  const [sshTarget, setSshTarget] = useState(values.sshTarget);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const sameHostDirect = viewerHostId !== '' && viewerHostId === host.id && sshTarget.trim() === '';
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 } as const;

  const workspacesQuery = useQuery({
    queryKey: ['paseo-ports', 'helper-workspaces', viewerHostId],
    enabled: viewerHostId !== '',
    retry: false,
    queryFn: async () => (await getPaseoClient(viewerHostId).workspaces.list()).entries,
  });

  async function submit() {
    const target = sshTarget.trim();
    if (!viewerHostId) { setError('Choose the Mac you are viewing from.'); return; }
    if (!sameHostDirect && !target) { setError('Enter an SSH alias or user@host. It may be empty only when the viewer Mac is this workspace’s own Mac.'); return; }
    if (!sameHostDirect && !helperWorkspaceId) { setError('Choose an existing workspace on the viewer Mac for the tunnel terminals.'); return; }
    setError(null);
    setSaving(true);
    try {
      const ok = await save(
        sameHostDirect
          ? { viewerHostId, helperWorkspaceId: '', sshTarget: '' }
          : { viewerHostId, helperWorkspaceId, sshTarget: target },
        revision,
      );
      if (ok) {
        toast.show('Connection settings saved', { variant: 'success' });
        onClose();
      }
    } catch (cause) {
      setError(errText(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Connection settings"
      icon={<Icon name="Cable" size={18} color={theme.colors.foreground} />}
      open
      onOpenChange={(open) => { if (!open && !saving) onClose(); }}
    >
      <Modal.Content>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
          To open apps from “{host.label}” locally, an SSH tunnel runs as a terminal inside a workspace
          on the Mac you are viewing from. SSH from that Mac to this workspace’s Mac must already work:
          key authentication and a trusted known-host entry. No credentials are stored here.
        </Text>

        <SettingsSelect
          label="Viewer Mac"
          hint="The Mac where apps open in a browser; it receives the local end of the tunnel. This pairing is saved for this host."
          value={viewerHostId}
          options={[
            { label: 'Choose a Mac…', value: '' },
            ...hosts.map((h) => ({
              label: `${h.label}${h.serverId === host.id ? ' (this workspace’s Mac)' : ''} · ${h.status}`,
              value: h.serverId,
            })),
          ]}
          onValueChange={(next) => { setViewerHostId(next); setHelperWorkspaceId(''); }}
        />

        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: '500' }}>SSH target</Text>
          <TextInput
            value={sshTarget}
            onChangeText={setSshTarget}
            placeholder="alias or user@host"
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{
              borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6,
              paddingHorizontal: 10, paddingVertical: 8, fontSize: 13,
              color: theme.colors.foreground, backgroundColor: theme.colors.surface2,
            }}
          />
          <Text style={muted}>
            How the viewer Mac’s SSH reaches this workspace’s Mac. Leave empty only when the viewer is this
            workspace’s own Mac: apps then open directly at localhost, without a tunnel.
          </Text>
        </View>

        {sameHostDirect ? (
          <Text style={muted}>
            Same Mac selected with no SSH target: apps open directly at localhost. No tunnel workspace or SSH needed.
          </Text>
        ) : (
          <>
            <SettingsSelect
              label="Tunnel workspace"
              hint="An existing workspace on the viewer Mac that hosts the tunnel terminals. Nothing is created for you."
              value={helperWorkspaceId}
              disabled={viewerHostId === '' || !workspacesQuery.data}
              options={[
                { label: viewerHostId !== '' && workspacesQuery.isPending ? 'Loading workspaces…' : 'Choose a workspace…', value: '' },
                ...(workspacesQuery.data ?? []).map((w) => ({ label: w.title ?? w.name, value: w.id })),
              ]}
              onValueChange={setHelperWorkspaceId}
            />
            {workspacesQuery.isError ? (
              <View style={{ gap: 6 }}>
                <ErrorNote theme={theme} text={`Could not list workspaces on the viewer Mac: ${errText(workspacesQuery.error)}`} />
                <Btn theme={theme} small label="Retry" onPress={() => void workspacesQuery.refetch()} />
              </View>
            ) : null}
          </>
        )}

        {error ? <ErrorNote theme={theme} text={error} /> : null}
        {saveError ? <ErrorNote theme={theme} text={saveError} /> : null}

        <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
          <Btn theme={theme} label="Cancel" disabled={saving} onPress={onClose} />
          <Btn theme={theme} kind="primary" label="Save" busy={saving} onPress={() => void submit()} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
