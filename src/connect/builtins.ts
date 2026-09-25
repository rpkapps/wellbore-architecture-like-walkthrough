import { z } from 'zod';
import * as batch from './batch';
import { avroCodec, arrowCodec, parquetCodec } from './codecs/binary';
import { lasCodec, witsCodec, xlsxCodec } from './codecs/files';
import { jsonCodec, msgpackCodec } from './codecs/json';
import { csvCodec, fixedWidthCodec, keyValueCodec, LineSplitter, regexCodec, TextStream } from './codecs/text';
import { witsmlCodec } from './codecs/witsml';
import { defineCodec, defineTransform, defineTransport, PluginRegistry, type Plugin } from './plugin';
import { replayTransport } from './replay';
import { BUILTIN_TRANSFORMS } from './transforms';
import { fileTransport, mqttTransport, pollTransport, relayTransport, sseTransport, urlTransport, websocketTransport } from './transports';
import { dlisCodec } from './codecs/dlis';

export const BUILTIN_CODECS = [
  csvCodec,
  jsonCodec,
  lasCodec,
  dlisCodec,
  witsmlCodec,
  witsCodec,
  xlsxCodec,
  parquetCodec,
  arrowCodec,
  avroCodec,
  msgpackCodec,
  fixedWidthCodec,
  regexCodec,
  keyValueCodec,
];
export const BUILTIN_TRANSPORTS = [fileTransport, urlTransport, pollTransport, sseTransport, websocketTransport, mqttTransport, relayTransport, replayTransport];

export function createRegistry(): PluginRegistry {
  return new PluginRegistry().register(...(BUILTIN_CODECS as Plugin[]), ...(BUILTIN_TRANSFORMS as Plugin[]), ...(BUILTIN_TRANSPORTS as Plugin[]));
}

/**
 * What a custom plugin module receives. A module's default export is either
 * a plugin, a list of plugins, or a function taking this API:
 *
 *   export default ({ defineCodec, z, batch }) => defineCodec({
 *     id: 'acme-rig', label: 'ACME rig feed', description: '…',
 *     options: z.object({}),
 *     create: () => ({ push: (chunk) => [batch.batchFromRows(['TIME', 'DBTM'], …)] }),
 *   });
 */
export const pluginApi = { z, defineCodec, defineTransform, defineTransport, batch, text: { LineSplitter, TextStream } };
export type PluginApi = typeof pluginApi;

export async function loadPluginModule(url: string, registry: PluginRegistry): Promise<Plugin[]> {
  const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
  let d = mod.default;
  if (typeof d === 'function') d = await (d as (api: PluginApi) => unknown)(pluginApi);
  const list = (Array.isArray(d) ? d : [d]) as Plugin[];
  if (!list.length || list.some((p) => !p || typeof p !== 'object')) throw new Error(`${url} does not export a plugin.`);
  registry.register(...list);
  return list;
}
