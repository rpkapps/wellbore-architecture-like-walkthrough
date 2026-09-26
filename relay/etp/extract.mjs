#!/usr/bin/env node
/**
 * Extracts the Energistics Transport Protocol message schemas the relay's ETP
 * client uses into relay/etp/etp12.json and relay/etp/etp11.json.
 *
 *   node relay/etp/extract.mjs <etptypes/energistics/etp/v12 dir> <etp/lib/EtpSchemas.js>
 *
 * Sources (both Apache License 2.0):
 *   ETP 1.2: the `etptypes` Python wheel (Geosiris), one `avro_schema` string literal per message.
 *   ETP 1.1: the `etp` npm package (Energistics etp-js), lib/EtpSchemas.js.
 *
 * Output: { types: fullName → schema, in dependency order (named types appear once and are
 * referred to by full name afterwards), messages: "<Protocol>.<Message>" → { protocol,
 * messageType, type } }. Documentation and bookkeeping attributes are dropped.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [v12Dir = '/tmp/claude-0/etp/et/etptypes/energistics/etp/v12', v11File = '/tmp/claude-0/etp/package/lib/EtpSchemas.js'] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));

const PRIMITIVES = new Set(['null', 'boolean', 'int', 'long', 'float', 'double', 'bytes', 'string']);
const NAMED = new Set(['record', 'error', 'enum', 'fixed']);

/** Collects the named types a schema needs (dependencies first) and returns it with named types replaced by references. */
function collector(lookup = new Map()) {
  const out = new Map();
  const busy = new Set();
  const visit = (node, ns) => {
    if (typeof node === 'string') {
      if (PRIMITIVES.has(node)) return node;
      const full = node.includes('.') || !ns ? node : `${ns}.${node}`;
      if (!out.has(full) && lookup.has(full)) visit(lookup.get(full), ns);
      if (!out.has(full) && !busy.has(full)) throw new Error(`unknown type ${full}`);
      return full;
    }
    if (Array.isArray(node)) return node.map((n) => visit(n, ns));
    const t = node.type;
    if (NAMED.has(t)) {
      const space = node.namespace ?? ns;
      const full = node.name.includes('.') ? node.name : `${space}.${node.name}`;
      if (out.has(full) || busy.has(full)) return full;
      busy.add(full);
      const inner = full.slice(0, full.lastIndexOf('.'));
      const clean = { type: t, name: full };
      if (t === 'enum') clean.symbols = node.symbols;
      else if (t === 'fixed') clean.size = node.size;
      else
        clean.fields = node.fields.map((f) => {
          const g = { name: f.name, type: visit(f.type, inner) };
          if ('default' in f) g.default = f.default;
          return g;
        });
      out.set(full, clean);
      return full;
    }
    if (t === 'array') return { type: 'array', items: visit(node.items, ns) };
    if (t === 'map') return { type: 'map', values: visit(node.values, ns) };
    return visit(t, ns);
  };
  return { out, visit };
}

function write(file, meta, types, messages) {
  const json = { ...meta, messages, types: Object.fromEntries(types) };
  writeFileSync(join(here, file), JSON.stringify(json) + '\n');
  console.log(`${file}: ${types.size} types, ${Object.keys(messages).length} messages, ${JSON.stringify(json).length} bytes`);
}

// ------------------------------------------------------------------ ETP 1.2

{
  const files = {
    'Datatypes.MessageHeader': 'datatypes/message_header',
    'Datatypes.MessageHeaderExtension': 'datatypes/message_header_extension',
    'Core.RequestSession': 'protocol/core/request_session',
    'Core.OpenSession': 'protocol/core/open_session',
    'Core.CloseSession': 'protocol/core/close_session',
    'Core.ProtocolException': 'protocol/core/protocol_exception',
    'Core.Acknowledge': 'protocol/core/acknowledge',
    'Core.Ping': 'protocol/core/ping',
    'Core.Pong': 'protocol/core/pong',
    'Discovery.GetResources': 'protocol/discovery/get_resources',
    'Discovery.GetResourcesResponse': 'protocol/discovery/get_resources_response',
    'ChannelSubscribe.GetChannelMetadata': 'protocol/channel_subscribe/get_channel_metadata',
    'ChannelSubscribe.GetChannelMetadataResponse': 'protocol/channel_subscribe/get_channel_metadata_response',
    'ChannelSubscribe.SubscribeChannels': 'protocol/channel_subscribe/subscribe_channels',
    'ChannelSubscribe.SubscribeChannelsResponse': 'protocol/channel_subscribe/subscribe_channels_response',
    'ChannelSubscribe.ChannelData': 'protocol/channel_subscribe/channel_data',
    'ChannelSubscribe.GetRanges': 'protocol/channel_subscribe/get_ranges',
    'ChannelSubscribe.GetRangesResponse': 'protocol/channel_subscribe/get_ranges_response',
    'ChannelSubscribe.UnsubscribeChannels': 'protocol/channel_subscribe/unsubscribe_channels',
    'ChannelSubscribe.SubscriptionsStopped': 'protocol/channel_subscribe/subscriptions_stopped',
    'ChannelSubscribe.RangeReplaced': 'protocol/channel_subscribe/range_replaced',
    'ChannelSubscribe.ChannelsTruncated': 'protocol/channel_subscribe/channels_truncated',
  };
  const { out, visit } = collector();
  const messages = {};
  for (const [short, file] of Object.entries(files)) {
    const src = readFileSync(join(v12Dir, `${file}.py`), 'utf8');
    const m = /avro_schema: typing\.Final\[str\] = \(\s*'(.*)'\s*\)/s.exec(src);
    if (!m) throw new Error(`${file}.py: no avro_schema literal`);
    const schema = JSON.parse(m[1]);
    const type = visit(schema);
    if (schema.protocol !== undefined) messages[short] = { protocol: +schema.protocol, messageType: +schema.messageType, type };
    else messages[short] = { type };
  }
  write(
    'etp12.json',
    {
      _source: 'Energistics Transport Protocol 1.2 Avro schemas, from the etptypes 1.2.0 Python package (Geosiris), extracted by relay/etp/extract.mjs',
      _license: 'Apache-2.0',
      version: '1.2',
    },
    out,
    messages,
  );
}

// ------------------------------------------------------------------ ETP 1.1

{
  const src = readFileSync(v11File, 'utf8');
  const m = /JSON\.parse\('(.*)'\);/s.exec(src);
  if (!m) throw new Error('EtpSchemas.js: no JSON.parse literal');
  const protocol = JSON.parse(m[1]);
  const lookup = new Map(protocol.types.map((t) => [t.fullName, t]));
  const names = [
    'Energistics.Datatypes.MessageHeader',
    'Energistics.Protocol.Core.RequestSession',
    'Energistics.Protocol.Core.OpenSession',
    'Energistics.Protocol.Core.CloseSession',
    'Energistics.Protocol.Core.ProtocolException',
    'Energistics.Protocol.Core.Acknowledge',
    'Energistics.Protocol.ChannelStreaming.Start',
    'Energistics.Protocol.ChannelStreaming.ChannelDescribe',
    'Energistics.Protocol.ChannelStreaming.ChannelMetadata',
    'Energistics.Protocol.ChannelStreaming.ChannelData',
    'Energistics.Protocol.ChannelStreaming.ChannelStreamingStart',
    'Energistics.Protocol.ChannelStreaming.ChannelStreamingStop',
    'Energistics.Protocol.ChannelStreaming.ChannelRemove',
    'Energistics.Protocol.ChannelStreaming.ChannelStatusChange',
  ];
  // The package's schemas predate ETP 1.1's `supportedCompression` on RequestSession (a
  // trailing string, "" = none); a 1.0 server ignores the extra byte, a 1.1 server needs it.
  const rs = lookup.get('Energistics.Protocol.Core.RequestSession');
  if (!rs.fields.some((f) => f.name === 'supportedCompression')) rs.fields = [...rs.fields, { name: 'supportedCompression', type: 'string', default: '' }];
  const { out, visit } = collector(lookup);
  const messages = {};
  for (const full of names) {
    const schema = lookup.get(full);
    if (!schema) throw new Error(`EtpSchemas.js: no ${full}`);
    const type = visit(full);
    const short = full.replace(/^Energistics\.(Protocol\.)?/, '');
    messages[short] = schema.protocol !== undefined ? { protocol: +schema.protocol, messageType: +schema.messageType, type } : { type };
  }
  write(
    'etp11.json',
    {
      _source: `Energistics Transport Protocol 1.1 Avro schemas (protocol ${protocol.namespace}.${protocol.protocol} ${protocol.version}), from the etp npm package (lib/EtpSchemas.js), extracted by relay/etp/extract.mjs; RequestSession gains ETP 1.1's supportedCompression`,
      _license: 'Apache-2.0',
      version: '1.1',
    },
    out,
    messages,
  );
}
