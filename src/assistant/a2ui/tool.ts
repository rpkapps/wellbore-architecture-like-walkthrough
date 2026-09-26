/*
 * The built-in `render_ui` tool. It only validates: the agent loop turns
 * the call's arguments into a UIPart, the transcript renders it with
 * `A2UISurface`, and this reply tells the model whether that worked (or
 * exactly what to fix, so it can call again).
 */
import type { AssistantTool, Dataset } from '../core/types';
import { flattenMessages } from './normalize';
import { DATA_CATALOG_ID } from './types';
import { validateMessages } from './validate';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The A2UI messages of a `render_ui` call's arguments (`messages`, or the official SDK's `a2ui_json` string). */
export function renderUiMessages(args: unknown): unknown[] {
  if (Array.isArray(args) || typeof args === 'string') return flattenMessages(args);
  if (!isRec(args)) return [];
  if (args.messages !== undefined) return flattenMessages(args.messages);
  if (args.a2ui_json !== undefined) return flattenMessages(args.a2ui_json);
  // a single message passed as the arguments themselves
  if ('createSurface' in args || 'updateComponents' in args) return [args];
  return [];
}

/** Surface ids created by a list of messages, in order. */
function surfaceIds(messages: unknown[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    const body = isRec(m) ? (m.createSurface ?? m.beginRendering) : undefined;
    if (isRec(body) && typeof body.surfaceId === 'string' && !ids.includes(body.surfaceId)) ids.push(body.surfaceId);
  }
  return ids;
}

/** The built-in `render_ui` tool: validates the A2UI messages and reports problems back to the model. */
export function renderUiTool(): AssistantTool {
  return {
    name: 'render_ui',
    title: 'Show generated UI',
    kind: 'read',
    description: [
      'Render an interactive UI inline in the chat with A2UI v0.9 messages (see the A2UI guide in the system prompt).',
      'Use it to show charts, depth profiles, tables, KPI metrics, callouts, forms or choice buttons. Prefer it over long Markdown tables or lists of numbers.',
      'Bind charts and tables to datasets by id ("dataset": "ds_1") instead of copying numbers into the call; the rows stay in the browser and every sample is plotted.',
      'Keep a surface small and focused (usually one per answer), then add a sentence or two of text interpreting it.',
      'If the result has ok:false, fix the listed errors and call again.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        messages: {
          type: 'array',
          description: `A2UI messages in order: createSurface (catalogId "${DATA_CATALOG_ID}"), then updateComponents (one component with id "root"), optionally updateDataModel.`,
          items: { type: 'object' },
        },
        a2ui_json: { type: 'string', description: 'Alternative to `messages`: the same array serialised as a JSON string.' },
      },
    },
    execute: (args, ctx) => {
      const messages = renderUiMessages(args);
      const datasets: ReadonlyMap<string, Dataset> | undefined = ctx?.datasets;
      if (!messages.length) {
        const raw = isRec(args) && typeof args.a2ui_json === 'string' ? args.a2ui_json : undefined;
        return { ok: false, errors: raw ? validateMessages(raw, { datasets }) : ['Pass `messages`: a non-empty array of A2UI messages (createSurface, then updateComponents).'] };
      }
      const errors = validateMessages(messages, { datasets });
      if (errors.length) return { ok: false, errors: errors.slice(0, 20), ...(errors.length > 20 ? { more: errors.length - 20 } : {}) };
      return { ok: true, surfaces: surfaceIds(messages), note: 'Rendered in the chat.' };
    },
  };
}
