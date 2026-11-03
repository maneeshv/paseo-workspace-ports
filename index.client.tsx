import type { PluginClientContext } from '@getpaseo/plugin/client';
import { PortsPanel } from '#client/panel';

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({ id: 'ports', title: 'Ports', icon: 'Network', context: 'workspace', Component: PortsPanel });
  client.addCommandCenterItem({ id: 'open-ports', title: 'Open workspace ports', icon: 'Network', context: 'workspace', onSelect: ({ openPanel }) => openPanel('ports') });
  client.addSlashCommand({ name: 'ports', description: 'Open workspace apps and tunnels', argumentHint: '', context: 'workspace', onSubmit: ({ openPanel }) => openPanel('ports') });
  return () => {};
}
