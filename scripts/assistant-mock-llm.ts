/*
 * A scripted stand-in for a language model, to try the Assistant (and to
 * drive it end to end) without a provider key. It answers in each provider's
 * exact streaming wire format (the kit's `mockServerHandler`), so the real
 * adapters, the agent loop, tools, approvals and generated charts all run.
 *
 *   pnpm assistant:demo            # http://localhost:8787
 *
 * Then in the Assistant: model menu › Manage providers › Add connection:
 *   Custom (OpenAI-compatible), base URL http://localhost:8787/v1, any key
 *   (or Anthropic with base URL http://localhost:8787, or Gemini with
 *   http://localhost:8787/v1beta). It understands a few requests: "What am I
 *   looking at?", "Plot the logs of this well", "Colour the well by
 *   hydrocarbons", "Chart the monthly oil production for all wells", "Where is
 *   the net pay by zone?", and "Write a long answer…". Env: PORT, DELAY (ms
 *   between streamed chunks). GET /__log lists the requests it saw.
 */
import { createServer } from 'node:http';
import { mockServerHandler, type MockRequest, type MockTurn } from '../src/assistant/testing/mockLLM.ts';

const DATA_CATALOG = 'urn:assistant-kit:catalog:data:v1';
const log: string[] = [];

const tool = (req: MockRequest, kit: string) => {
  const flat = kit.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const n = req.toolNames.find((t) => t.replace(/[^a-z0-9]/gi, '').toLowerCase() === flat);
  if (!n) throw new Error(`tool ${kit} not offered; have ${req.toolNames.length}`);
  return n;
};
const parse = (c: unknown): any => {
  if (typeof c === 'string') {
    try {
      return JSON.parse(c);
    } catch {
      return c;
    }
  }
  return c;
};
const dsId = (r: MockRequest, i = 0): string | undefined => {
  const c = parse(r.toolResults[i]?.content);
  const s = JSON.stringify(c ?? null);
  return s.match(/"(ds_\d+)"/)?.[1];
};
const stateOf = (text: string) => {
  const m = text.match(/<app_state>[\s\S]*?(\{[\s\S]*?\})\s*\n\s*\n/);
  try {
    return m ? JSON.parse(m[1]) : {};
  } catch {
    return {};
  }
};

/** What the mock model says to a request: tool calls step by step, then an answer. */
function brain(req: MockRequest): MockTurn {
  const raw = req.lastUserText;
  const q = raw.replace(/<app_state>[\s\S]*?<\/app_state>/, '').replace(/<context>[\s\S]*?<\/context>/, '').toLowerCase();
  const st = stateOf(raw);
  const well = st.openWell?.id ?? 'F-11B';
  log.push(`[${req.protocol}] step ${req.stepIndex} q="${q.trim().slice(0, 60)}" results=${req.toolResults.map((r) => r.name).join(',')}`);

  if (q.includes('<ui_event>') || q.includes('ui_event')) {
    return { text: 'Moving the camera to **3,000 m MD** now — the log view on the right follows it.' };
  }

  // 0. a long streamed answer (performance check)
  if (/essay|long answer/.test(q)) {
    const para = 'The Hugin Formation is a shallow-marine to deltaic sandstone of Middle to Late Jurassic age; at Volve it is the main reservoir, with porosity of 20–30 % and permeability up to several darcies. ';
    const table = '\n\n| Zone | Gross (m) | Net (m) | NTG | φ | Sw |\n|---|---:|---:|---:|---:|---:|\n' + Array.from({ length: 12 }, (_, i) => `| Zone ${i + 1} | ${(20 + i * 3).toFixed(1)} | ${(12 + i * 2).toFixed(1)} | 0.${60 + i} | 0.2${i % 10} | 0.3${i % 10} |`).join('\n');
    const code = '\n\n```python\nimport numpy as np\n\ndef vsh(gr, gr_min=12, gr_max=112):\n    return np.clip((gr - gr_min) / (gr_max - gr_min), 0, 1)\n```\n\n';
    return { reasoning: 'Write a long, structured answer.', text: ('## Reservoir overview\n\n' + para.repeat(6) + table + code + '### Notes\n\n' + '- ' + para + '\n').repeat(4) };
  }

  // 1. what am I looking at → app.state, then a summary
  if (/looking at|what.*(screen|see)/.test(q)) {
    if (req.stepIndex === 0) return { reasoning: 'The person asks about the view. Read the app state first.', toolCalls: [{ name: tool(req, 'app.state'), args: {} }] };
    const s = parse(req.toolResults[0]?.content);
    const w = s?.well?.name ?? 'the active well';
    const p = s?.position ?? {};
    return {
      text: `You are looking at **${w}** in the Volve field, in *${s?.navigation?.mode ?? 'explore'}* navigation.\n\n- Camera depth: **${p.md ?? '—'} m MD** (${p.tvdss ?? '—'} m TVDSS)${p.formation ? `, in the **${p.formation}**` : ''}\n- The tube is coloured by **${s?.colourBy ?? '—'}**\n- Open panels: ${(s?.panels ?? []).join(', ') || 'none'}\n\nAsk me to plot its logs, or to fly to the reservoir.`,
    };
  }

  // 2. plot logs → data.log_samples, render_ui DepthChart, text
  if (/log|gamma|resistiv/.test(q)) {
    if (req.stepIndex === 0)
      return {
        reasoning: 'Fetch GR, deep resistivity and density over the reservoir section, then plot them as a depth chart.',
        text: 'Pulling the logs over the reservoir section.',
        toolCalls: [{ name: tool(req, 'data.log_samples'), args: { well, curves: ['GR', 'RT', 'RHOB', 'NPHI'], fromMd: 2900, toMd: 3500 } }],
      };
    if (req.stepIndex === 1) {
      const ds = dsId(req);
      const c = parse(req.toolResults[0]?.content);
      const tops = (c?.tops ?? []).slice(0, 8).map((t: any) => ({ depth: t.md, label: t.name ?? t.formation }));
      return {
        toolCalls: [
          {
            name: tool(req, 'render_ui'),
            args: {
              messages: [
                { version: 'v0.9', createSurface: { surfaceId: 'logs', catalogId: DATA_CATALOG } },
                {
                  version: 'v0.9',
                  updateComponents: {
                    surfaceId: 'logs',
                    components: [
                      { id: 'root', component: 'Column', children: ['title', 'chart', 'go'] },
                      { id: 'title', component: 'Text', text: `Logs of ${well}, 2,900–3,500 m MD`, variant: 'h4' },
                      {
                        id: 'chart',
                        component: 'DepthChart',
                        dataset: ds,
                        depth: 'md',
                        depthUnit: 'm MD',
                        height: 420,
                        tracks: [
                          { title: 'GR', curves: [{ column: 'GR', label: 'GR', color: 'chart-3' }], scale: 'linear', min: 0, max: 150 },
                          { title: 'Resistivity', curves: [{ column: 'RT', label: 'RT', color: 'chart-1' }], scale: 'log' },
                          { title: 'Density · Neutron', curves: [{ column: 'RHOB', label: 'RHOB', color: 'chart-2' }, { column: 'NPHI', label: 'NPHI', color: 'chart-4' }] },
                        ],
                        markers: tops,
                      },
                      { id: 'go', component: 'Button', child: 'go_t', action: { event: { name: 'fly_to_depth', context: { md: 3000 } } } },
                      { id: 'go_t', component: 'Text', text: 'Fly to 3,000 m' },
                    ],
                  },
                },
              ],
            },
          },
        ],
      };
    }
    return {
      text: `The Hugin sands show as the **low gamma ray** (< 60 API) interval with **high deep resistivity** (tens of ohm·m) — the hydrocarbon-bearing reservoir. The density–neutron crossover inside it supports light hydrocarbons. Chart data: dataset \`ds_1\`.`,
    };
  }

  // 3. production → data.production_history, Chart
  if (/production|oil/.test(q)) {
    if (req.stepIndex === 0) return { toolCalls: [{ name: tool(req, 'data.production_history'), args: { period: 'monthly', fields: ['oil', 'water'], rates: true } }] };
    if (req.stepIndex === 1) {
      const ds = dsId(req);
      const cols = JSON.stringify(parse(req.toolResults[0]?.content)).match(/"key":"([^"]+)"/g)?.map((s) => s.slice(7, -1)) ?? [];
      const series = cols.filter((c) => /oil/i.test(c)).slice(0, 5).map((column) => ({ column, label: column }));
      log.push(`production columns: ${cols.join(',')}`);
      return {
        toolCalls: [
          {
            name: tool(req, 'render_ui'),
            args: {
              messages: [
                { version: 'v0.9', createSurface: { surfaceId: 'prod', catalogId: DATA_CATALOG } },
                {
                  version: 'v0.9',
                  updateComponents: {
                    surfaceId: 'prod',
                    components: [
                      { id: 'root', component: 'Column', children: ['title', 'chart'] },
                      { id: 'title', component: 'Text', text: 'Oil rate by well', variant: 'h4' },
                      { id: 'chart', component: 'Chart', kind: 'line', dataset: ds, x: cols.find((c) => /date|month/.test(c)) ?? 'date', xType: 'time', yLabel: 'Sm³/d', series: series.length ? series : [{ column: cols[1] }] },
                    ],
                  },
                },
              ],
            },
          },
        ],
      };
    }
    return { text: 'Volve peaked in **2009–2010**; F-12 and F-14 carried most of the oil, and water cut rose steadily after 2011.' };
  }

  // 4. pay / zones → data.zone_summary → metrics + table
  if (/pay|zone|reservoir quality/.test(q)) {
    if (req.stepIndex === 0) return { toolCalls: [{ name: tool(req, 'data.zone_summary'), args: { well } }] };
    if (req.stepIndex === 1) {
      const ds = dsId(req);
      return {
        toolCalls: [
          {
            name: tool(req, 'render_ui'),
            args: {
              messages: [
                { version: 'v0.9', createSurface: { surfaceId: 'zones', catalogId: DATA_CATALOG } },
                {
                  version: 'v0.9',
                  updateComponents: {
                    surfaceId: 'zones',
                    components: [
                      { id: 'root', component: 'Column', children: ['title', 'table'] },
                      { id: 'title', component: 'Text', text: `Net pay by zone · ${well}`, variant: 'h4' },
                      { id: 'table', component: 'DataTable', dataset: ds },
                    ],
                  },
                },
              ],
            },
          },
        ],
      };
    }
    return { text: 'The **Hugin** zone holds nearly all the net pay in this well.' };
  }

  // 5. colour by → write action (approval in Ask mode)
  if (/colou?r/.test(q)) {
    if (req.stepIndex === 0) return { text: 'Switching the colouring.', toolCalls: [{ name: tool(req, 'view.color_by'), args: { mode: 'hydrocarbon' } }] };
    const r = JSON.stringify(parse(req.toolResults[0]?.content));
    if (/denied|declined/.test(r)) return { text: 'OK — I left the colouring as it was.' };
    return { text: 'Done: the well is now coloured by **hydrocarbons** (from the petrophysical interpretation).' };
  }

  return { text: `I can read the app's state and data, plot logs and production, and operate the view. (Mock model; you said: “${q.trim().slice(0, 80)}”)` };
}

const handle = mockServerHandler(brain, { chunkSize: 8, models: ['mock-large', 'mock-small'] });
const DELAY = Number(process.env.DELAY ?? 12);
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const bodyText = Buffer.concat(chunks).toString('utf8');
  if (req.url === '/__log') {
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end(log.join('\n'));
    return;
  }
  try {
    const out = await handle({ url: req.url ?? '/', method: req.method, headers: req.headers as Record<string, string>, bodyText });
    res.writeHead(out.status, out.headers);
    for (const c of out.chunks) {
      res.write(c);
      if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
    }
    res.end();
  } catch (e) {
    log.push(`ERROR ${(e as Error).message}`);
    res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ error: { message: (e as Error).message } }));
  }
}).listen(Number(process.env.PORT ?? 8787), () => console.log('mock llm on', process.env.PORT ?? 8787));
