import { defineRpc, defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

export const PortSchema = z.number().int().min(1024).max(65535);
export const TargetSchema = z.enum(['127.0.0.1', '::1']);
export const AppSchema = z.object({
  id: z.string(), name: z.string(), source: z.enum(['managed', 'detected']),
  status: z.enum(['running', 'stopped', 'unknown']),
  listening: z.boolean(),
  port: z.number().int().min(1).max(65535).nullable(), pid: z.number().int().positive().nullable(),
  scriptName: z.string().nullable(), terminalId: z.string().nullable(), detail: z.string(),
  targetHost: TargetSchema,
});
export type App = z.infer<typeof AppSchema>;
const workspace = z.object({ workspaceId: z.string().min(1).max(256) });
export const listAppsRpc = defineRpc({ name: 'apps.list', input: workspace,
  output: z.object({ apps: z.array(AppSchema), warnings: z.array(z.string()) }) });
export const controlAppRpc = defineRpc({ name: 'apps.control',
  input: workspace.extend({ scriptName: z.string().min(1).max(256), action: z.enum(['start', 'stop']) }),
  output: z.object({ ok: z.literal(true) }) });
export const appLogsRpc = defineRpc({ name: 'apps.logs',
  input: workspace.extend({ scriptName: z.string().min(1).max(256) }), output: z.object({ text: z.string() }) });
export const pairing = defineSettings({ id: 'pairing', scope: 'host', version: 1,
  schema: z.object({
    viewerHostId: z.string().default(''),
    helperWorkspaceId: z.string().default(''),
    sshTarget: z.string().max(253).regex(/^$|^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/, 'Enter an SSH alias or user@host, without spaces.').default(''),
  }),
});
export type Pairing = z.infer<typeof pairing.schema>;
