# BoreWalk relay

One small Node process between BoreWalk (in the browser) and the sources a browser cannot or should not reach itself: Kafka, rig feeds over TCP, WITSML stores, ETP servers, OSDU, MQTT brokers on TCP, and HTTP APIs that need a secret or do not allow the page's origin.

- **Credentials stay here.** Sources are configured on the relay. A browser names a source and passes only the options that source allows (a start time, a well, a subset of topics or curves). `GET /sources` lists the sources with those options and what the browser may see, never the credentials.
- **The browser does the decoding.** The relay announces the format of what follows (for example `json`, `witsml` or `wits0`) and forwards messages. The app's own codecs read them, with the same steps and preview as any other connection. Kafka Avro and Protobuf, and ETP, are decoded here into JSON lines.
- **Backpressure end to end.** The relay sends to a browser only while that browser keeps up, up to 8 MB queued (`highWater`). Meanwhile a Kafka consumer pauses, and polls and TCP reads wait. The browser, in turn, acknowledges each delivery only once it is applied.

## Run

```bash
pnpm relay:build                         # relay/dist/relay.mjs: one file, no install needed next to it (Node 20+)
RELAY_TOKEN=… node relay/dist/relay.mjs relay.config.json
```

The config is JSON, and any `${NAME}` in it is read from the environment, so secrets need not sit in the file. See [`relay.config.example.json`](relay.config.example.json).

| Key              |                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `port`, `host`   | where to listen (default `0.0.0.0:8787`)                                                                                       |
| `tokens`         | access tokens a browser must present. **Empty means no check**, which is for local development only; the relay warns at start. |
| `origins`        | page origins allowed to connect and to call `/sources`. Empty means any origin.                                                |
| `maxConnections` | default 64                                                                                                                     |
| `highWater`      | bytes a browser may lag behind before sources are paused (default 8 MB)                                                        |
| `sources`        | `{ id: { type, label, …settings } }`. The settings for each type are below.                                                    |

Put the relay behind TLS (a reverse proxy, or a platform that terminates TLS) and use `wss://` from the page.

In the app, open **Live → Connect a source → Relay**. Enter the relay's address and token, then **Load sources**, choose one and **Preview**.

## Source types

| `type`   | Settings                                                                                                                                                                                                                                                                                                                       | Browser options                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `kafka`  | `brokers`, `ssl`, `sasl {mechanism: plain / scram-sha-256 / scram-sha-512, username, password}`, `topics`, `value` (`auto` / `json` / `avro` / `protobuf` / `text`), `textFormat` (codec for text values, e.g. `csv`, `wits0`), `schemaRegistry {url, username, password}`, `wellField` (`key` or a JSON path naming the well) | `from` (`latest`, `earliest`, `6h`, a date), `topics`, `well` |
| `witsml` | `url`, `username`, `password`, `version` (`1.4.1.1` / `1.3.1.1`), `uidWell`, `uidWellbore`, `logs` (empty: discover them), `trajectory`, `markers`, `interval` (s)                                                                                                                                                             | `from`                                                        |
| `etp`    | `url` (`wss://…`), `version` (`1.2` / `1.1`), `auth {kind: none / basic / bearer, …}`, `uris` (channels, or logs / channel sets / wellbores to discover channels under), `well`, `maxMessageRate`, `maxDataItems`                                                                                                              | `from`, `channels`                                            |
| `osdu`   | `baseUrl`, `partition`, `auth` (`{kind: token, token}` or `{kind: client-credentials, tokenUrl, clientId, clientSecret, scope}`), `wellbores` (record ids), `interval` (s, 0 = once)                                                                                                                                           | `wellbore`, `curves`                                          |
| `tcp`    | `host`, `port`, `tls`, `format` (default `wits0`), `send` (a request line after connecting), `chunkMs`                                                                                                                                                                                                                         | —                                                             |
| `mqtt`   | `host`, `port`, `tls`, `username`, `password`, `topics`, `qos`, `format`                                                                                                                                                                                                                                                       | `topics`                                                      |
| `http`   | `url` (with `{lastTime}`, `{now}`), `method`, `headers`, `body`, `interval` (s, 0 = once), `format`, `formatOptions`, `cursor` (JSON path to the newest time in a response)                                                                                                                                                    | `from`                                                        |
| `file`   | `path`, `format`, `formatOptions`, `rate` (lines or WITS records per second, 0 = all at once), `loop`, `headerLines`                                                                                                                                                                                                           | `speed`                                                       |

Adding a source type means adding one file under `adapters/`: a `defineAdapter({ type, label, config, params, describe, open })`. `config` and `params` are Zod schemas, and `open(config, ctx)` reads from the source and awaits `ctx.send(payload, meta)`. Register it in `adapters/index.ts`.

## Protocol (browser ↔ relay)

1. The browser opens a WebSocket with the subprotocol `borewalk-relay.v1` and sends `{"type":"hello","token":"…","source":"<id>","params":{…}}` within 10 s.
2. The relay checks the token and the origin, then validates `params` against the source's schema.
3. It answers `{"type":"ready","format":"<codec id>","formatOptions":{…},"detail":"…"}`.
4. Data follows as binary messages, each one a `u32` big-endian header length, a JSON header `{topic, key, ts, contentType, text}`, then the payload.
5. Control messages are JSON: `{"type":"status","state","detail"}`, `{"type":"log","text","level"}`, `{"type":"end"}` (a resource is complete; the browser starts a fresh decoder), and `{"type":"error","text","fatal"}`.

## Tested, and what is assumed

The relay runs end to end in `tests/relay.test.ts`: from a recorded CSV feed and from WITS over TCP into the browser pipeline, Kafka with Avro values behind a Schema Registry (with a fake consumer), MQTT over TCP, token and source checks, and the source list without secrets. `tests/relay-witsml-osdu.test.ts` and `tests/relay-etp.test.ts` run the WITSML, OSDU and ETP adapters against fake servers written from the specifications. **None of the adapters has been run against a production system.** The details that are assumptions:

- **Kafka:** the client is [KafkaJS](https://kafka.js.org), which is pure JavaScript, so the bundle runs anywhere without native builds. For Protobuf, `import`s between Schema Registry subjects (schema references) are not resolved.
- **WITSML:**
  - The SOAP body uses the `http://www.witsml.org/message/120` namespace, as the WITSML API 1.2.0 WSDL's rpc/encoded binding does. If a store rejects it, the namespace is the `MESSAGE_NS` constant in `adapters/witsml.ts`.
  - It assumes stores accept `returnElements=header-only` and `id-only` for 1.3.1.1 as well as 1.4.1.1, and that `uid=""` in a query means "all".
- **ETP:**
  - The ETP 1.2 schemas come from Geosiris' `etptypes` (Apache-2.0) and the 1.1 ones from Energistics' `etp` npm package (Apache-2.0), extracted by `etp/extract.mjs`.
  - Message flags were written from memory: header extension `0x20`, compressed `0x08`, acknowledge `0x10`, FIN `0x02`.
  - "Latest only" is a subscribe with no start index.
  - For container URIs, Discovery asks for `witsml20.Channel` and `witsml21.Channel` resources.
- **OSDU:**
  - Confident: the search, storage, `WellLog` fields (`ReferenceCurveID`, `Curves[].CurveID` / `CurveUnit`) and the header conventions.
  - Fairly sure, not verified: the Wellbore DDMS v3 bulk-data paths (`/api/os-wellbore-ddms/ddms/v3/welllogs/{id}/data?orient=split`, and the same for `wellboretrajectories`).
  - Least certain: trajectory column names and units, which are matched by name.
  - Each poll re-reads a log's bulk data and sends only the new rows.
