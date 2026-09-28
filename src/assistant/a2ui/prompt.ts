/*
 * The A2UI part of the system prompt. It is sent with every request, so it
 * stays compact: the message shapes by one complete example, the component
 * list with the props that matter, and the rules a model tends to break.
 * `PROMPT_EXAMPLE` is exported so a test can prove the example validates.
 */
import { DATA_CATALOG_ID } from './types';

/** The guide's worked example (validated in tests against a dataset `ds_1` with columns `md`, `gr`). */
export const PROMPT_EXAMPLE = [
  { version: 'v0.9', createSurface: { surfaceId: 'gr_log', catalogId: DATA_CATALOG_ID } },
  {
    version: 'v0.9',
    updateComponents: {
      surfaceId: 'gr_log',
      components: [
        { id: 'root', component: 'Column', children: ['title', 'chart', 'more'] },
        { id: 'title', component: 'Text', text: 'Gamma ray, 3000–3100 m', variant: 'h4' },
        { id: 'chart', component: 'Chart', kind: 'line', dataset: 'ds_1', x: 'md', xLabel: 'MD (m)', series: [{ column: 'gr', label: 'GR' }] },
        { id: 'more', component: 'Button', child: 'more_t', action: { event: { name: 'show_next_interval', context: { from: 3100 } } } },
        { id: 'more_t', component: 'Text', text: 'Next 100 m' },
      ],
    },
  },
];

/** The part of the system prompt that teaches the model the protocol and the catalog. */
export function a2uiPromptGuide(): string {
  return `## Generated UI (A2UI v0.9)
Call \`render_ui\` with \`messages\`: an array of A2UI messages to show charts, tables, metrics or buttons inline (prefer it to long Markdown tables). Or write the same array in a \`\`\`a2ui fenced block.
Example:
${JSON.stringify(PROMPT_EXAMPLE)}

Messages (each has "version":"v0.9" and exactly one of):
- createSurface {surfaceId, catalogId:"${DATA_CATALOG_ID}"} — always first.
- updateComponents {surfaceId, components:[…]} — a flat list; each component is {"id","component":"<Type>",…props}; children are referenced by id.
- updateDataModel {surfaceId, path:"/form", value:{…}} — data for {"path"} bindings and inputs.
- deleteSurface {surfaceId}.

Values: a literal, or {"path":"/pointer"} into the data model (inside a template, a relative path like "name" is the current item), or {"call":"formatNumber","args":{"value":{"path":"/x"},"decimals":1}} (also formatString with "\${/path}", formatDate, formatCurrency, pluralize, required, and, or, not).

Layout & content: Column/Row {children:[ids], justify, align} · List {children: ids or {"componentId":"row_tpl","path":"/items"} to repeat a template per array item} · Card {child} · Tabs {tabs:[{title, child}]} · Modal {trigger (Button id), content} · Divider · Text {text (inline **bold** *italic* \`code\` [link](https://…)), variant h1…h5|caption|body} · Image {url, description} · Icon {name: info|warning|check|error|search|settings|star|…}.
Input (two-way bound to their path): Button {child (a Text id), action:{"event":{"name","context":{k: value or {"path"}}}}, variant primary|default|borderless} · TextField {label, value:{"path"}, variant shortText|longText|number|obscured} · CheckBox {label, value} · ChoicePicker {options:[{label, value}], value:{"path"} (a string array), variant mutuallyExclusive|multipleSelection, displayStyle checkbox|chips} · Slider {value, min, max, label} · DateTimeInput {value, enableDate, enableTime}.
Data (take rows from "dataset":"<id>" a tool returned, or inline "rows":[{…}], or "path"):
- Chart {kind line|area|bar|scatter|pie|composed, x:"<column>", series:[{column, label, kind (composed), axis left|right, stack, color chart-1…chart-5}], xType number|category|time, xLabel, yLabel, yScale linear|log, title, height}. Pie: x = category column, first series = value.
- DepthChart {depth:"<column>", tracks:[{title, curves:[{column, label, color}], scale linear|log, min, max}], bands:[{from, to, label, color}], markers:[{depth, label}], depthUnit, title, height} — depth-indexed logs/profiles, depth downward, tracks side by side.
- DataTable {columns:[{key, label, unit, format number|integer|percent|date|datetime|text, digits}], maxRows, title} (columns default to all).
- Metric {label, value, unit, digits, delta, deltaTone good|bad|neutral, caption, sparkline:{dataset, column}} · MetricGroup {children:[Metric ids]}.
- KeyValue {items:[{label, value, unit}], title} · Badge {text, tone} · Callout {title, text, tone} · Progress {value, max, label, tone} · Code {code, language} (tone: neutral|info|success|warning|danger).

Rules:
- Exactly one component has id "root"; ids are unique; every referenced id is defined; root and parents first.
- Bind to datasets by id and use their exact column names; never copy dataset numbers into rows.
- A Button press comes back to you as the person's next message with the event name and resolved context: put what you need (ids, form values via {"path"}) in context.
- Keep it small: usually one surface per answer, a title, one to three data components, a few buttons at most. Explain the result in text next to it, never repeat its numbers in a Markdown table.
- If render_ui returns ok:false, fix the listed errors and call it again.`;
}
