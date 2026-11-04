import type { PluginServerContext } from '@getpaseo/plugin/server';
import { appLogs, controlApp, listApps } from '#server/apps';
import { listShares, startShare, stopShare } from '#server/share';
import { appLogsRpc, controlAppRpc, listAppsRpc, listSharesRpc, pairing, startShareRpc, stopShareRpc } from '#shared/contracts';

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
  server.handle(listSharesRpc, ({ workspaceId }, { paseo }) => listShares(paseo, workspaceId));
  server.handle(startShareRpc, async ({ workspaceId, appId, httpsPort }, { paseo }) => ({
    share: await startShare(paseo, workspaceId, appId, httpsPort),
  }));
  server.handle(stopShareRpc, async ({ workspaceId, terminalId }, { paseo }) => {
    await stopShare(paseo, workspaceId, terminalId);
    return { ok: true as const };
  });
  return () => {};
}
