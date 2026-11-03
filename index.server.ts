import type { PluginServerContext } from '@getpaseo/plugin/server';
import { appLogs, controlApp, listApps } from '#server/apps';
import { appLogsRpc, controlAppRpc, listAppsRpc, pairing } from '#shared/contracts';

export default function contribute(server: PluginServerContext) {
  server.registerSettings(pairing);
  server.handle(listAppsRpc, ({ workspaceId }, { paseo }) => listApps(paseo, workspaceId));
  server.handle(controlAppRpc, async ({ workspaceId, scriptName, action }, { paseo }) => {
    await controlApp(paseo, workspaceId, scriptName, action);
    return { ok: true as const };
  });
  server.handle(appLogsRpc, async ({ workspaceId, scriptName }, { paseo }) => ({
    text: await appLogs(paseo, workspaceId, scriptName),
  }));
  return () => {};
}
