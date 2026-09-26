# Assistant kit

An in-app AI assistant for a React app, with no backend. The browser talks to
the model provider directly, using the person's own key. The assistant can:

- answer questions about what is on screen and the data behind it;
- operate the app through its tools, asking for approval first where it should;
- show charts, tables, metrics and buttons inside its answers, as generated
  interfaces in the [A2UI](https://a2ui.org) v0.9 protocol.

Everything in this folder is generic. It imports nothing from the app around
it. To use it in another project, copy the folder and write a host.

```
src/assistant/
  core/        contracts (types.ts), the agent loop, the controller, datasets, persistence
  providers/   OpenAI-compatible, Anthropic and Gemini over fetch + SSE; provider presets
  a2ui/        A2UI v0.9 processor, validator and React renderer; the data catalog
  ui/          the chat panel: transcript, Markdown, composer, settings
  testing/     a scripted mock model that speaks every provider's wire format
```

## Use it in a project

1. **Copy** `src/assistant/` into the project.
2. **Check the dependencies.** It needs `react` 19, `@tecton/react` (the
   panel is built from its conversation components; import
   `@tecton/react/globals.css` once), `lucide-react`, `recharts` 3 and `cn`.
   There are no provider SDKs; requests go through `fetch`.
3. **Check Tailwind.** Tailwind v4 has to scan the folder. It does
   automatically when the folder is under the project root; otherwise add
   `@source "…/assistant";` to your CSS.
4. **Write a host.** This is the only app-specific code (see below).
5. **Mount it, lazily**, so the app pays nothing until the panel opens:

```tsx
const AssistantChunk = lazy(() => import('./my-assistant'));   // default export below

// my-assistant.tsx
import { AssistantPanel, createAssistant } from './assistant';
const assistant = createAssistant(myHost);                     // once: it outlives the panel
export default function MyAssistant() {
  return <AssistantPanel controller={assistant} onClose={close} />;
}
```

Give the panel a container with a height: a docked side panel of 360–520 px
works well, and it still works at 320 px.

## The host

`AssistantHost` is defined in `core/types.ts`:

| member | what it is |
|---|---|
| `appName` | The assistant presents itself as "the assistant built into …". |
| `instructions()` | Domain knowledge and house rules for the system prompt. Keep it stable: it is part of the cached prefix. |
| `tools()` | `AssistantTool[]`: name, description, JSON Schema `parameters`, `kind: 'read' \| 'write'`, `needsApproval`, and `execute(args, ctx)`. Read at every step. |
| `context()` / `subscribeContext()` | Chips attached to the next message, such as the selection. The person can remove them. |
| `snapshot()` | A small JSON picture of the app, recorded with each message the person sends. |
| `suggestions()` | Prompts for the empty state. |
| `captureView()` | Optional. Attaches a picture of the main view, for vision models. |
| `renderIcon(name)`, `onLink(href)` | Optional. Icons for chips; `app://…` links in answers. |
| `storageKey` | Namespace for threads (IndexedDB) and settings (localStorage). |

**Datasets.** A tool can return `{ content, datasets: [{ title, columns, rows }] }`.
The rows stay in the browser. The model is shown the dataset's id, columns,
size, a few sample rows and per-column statistics. It charts the dataset by
binding an A2UI `Chart`, `DepthChart` or `DataTable` to the id, and can
filter or aggregate it with the built-in `query_dataset` tool. So a chart of
5,000 samples costs a few hundred tokens and still draws every point
(downsampled with LTTB only on screen).

**Approvals.** The person chooses the mode in the composer:

- *Read only*: tools of kind `write` are not offered at all.
- *Ask first* (the default): every write waits for Approve or Deny.
- *Auto*: only tools marked `needsApproval` wait.

## Providers

Presets are in `providers/presets.ts`: OpenAI, Anthropic, Google Gemini,
DeepSeek, OpenRouter, Groq, Mistral, xAI, Together, Fireworks, Cerebras,
Ollama and LM Studio (both local), and Custom (any OpenAI-compatible
endpoint). The model lists are only suggestions. *Fetch models* reads the
provider's own list, and any model id can be typed.

Four wire protocols cover all of them: OpenAI Chat Completions, the OpenAI
Responses API, Anthropic Messages and Gemini `streamGenerateContent`. They
handle streaming, parallel tool calls, reasoning (DeepSeek
`reasoning_content`, OpenAI reasoning summaries with encrypted reasoning
replayed across tool calls, Claude adaptive thinking with signatures, Gemini
thoughts and thought signatures), usage and errors in plain language.

The OpenAI preset uses the Responses API (`POST /responses`, stateless with
`store: false`): OpenAI's newest reasoning models take function tools with
reasoning only there. Its connection form, and Custom's, offer *API:
Responses / Chat Completions*; OpenAI connections saved before are moved to
Responses when the settings load. On Chat Completions, a model that refuses
tools with reasoning is asked again with `reasoning_effort: 'none'`, and that
is remembered for the base URL and model.

A few things matter when the browser calls providers directly:

- **Keys** live in this browser only. By default they are in sessionStorage;
  they go to localStorage only if the person turns on *Remember keys*. They
  are sent only to the provider.
- **CORS.** Some providers refuse browser requests. For those, set a
  *CORS proxy* prefix on the connection (`https://proxy.example/` or
  `https://proxy.example/?url={url}`). Local servers need their origin
  allowed, for example `OLLAMA_ORIGINS=*`.
- **Prompt caching.** The system prompt stays byte-identical for the whole
  conversation. The app's state travels with each user message instead.
  Provider caches therefore hit from turn to turn, and Claude's replayed
  thinking stays valid.

## Context

The person never has to manage the model's context window; the kit keeps
every request inside it (`core/context.ts`, `core/compaction.ts`).

- **Budget.** The window comes from the connection's `contextWindow`, else
  from the provider's model list (Anthropic, Gemini and OpenRouter report
  it; OpenRouter's is read once per session), else from a default per
  preset or model family (`providers/presets.ts`). Million-token windows
  are capped at 200k (`MAX_WORKING_CONTEXT`) to keep cost and latency sane.
  Room for the answer is kept free. Tokens are estimated from characters
  and corrected per thread by the input tokens the provider reports.
- **Every request** shortens tool results older than the last few turns to
  a stub (`{elided, summary, datasets}`: datasets stay usable by id) and
  leaves out their reasoning and recorded app state. The shortened region
  grows four turns at a time, so prompt caches keep hitting in between.
  Only the request changes; the transcript keeps everything.
- **At 70 % of the budget** one model call summarises everything but the
  last two turns. The summary is stored on the thread (`Thread.compactions`,
  append-only; the transcript shows a divider) and requests send it in
  place of the messages it covers. `compact()` (the `/compact` command) does
  the same on demand. While it runs, `snapshot.context.compacting` is true.
- **If the provider still says the request is too long**, everything before
  the current turn is summarised (or outlined, if the summary fails too)
  and the request is sent again, once.
- **Many tools, small window.** When the tool definitions would take more
  than 15 % of the window (or the window is 32k or less), only tools marked
  `core: true` and the kit's own are offered, plus `find_tools`: the model
  searches the others by keyword, and what it finds stays offered for the
  thread. The choice is made at a thread's first turn, so the system prompt
  stays the same from turn to turn.
- **Transient errors** (rate limits, overload, server errors, network) are
  retried up to three times before any output arrived, after 1 s, 2 s and
  4 s (or the provider's `retry-after`, up to 20 s).

`snapshot.context` (`{ used, window, compacting }`) drives the panel's meter.

## Performance

- Nothing runs while the panel is closed, and the kit is a separate chunk.
- Streamed updates reach React at most about 30 times a second.
- Only the message that is streaming re-renders. Only its last Markdown
  block is re-parsed, and older rows use `content-visibility: auto`.
- Charts downsample to at most 1,500 points per series, without animation.

## Tests

`tests/assistant/` covers:

- `core-*`: the agent loop through every protocol, the context budget,
  compaction, tool deferral and retries;
- `providers-*`: wire conversion and stream parsing against recorded SSE;
- `a2ui-*`: the processor, the validator and rendering;
- `ui-*`: Markdown and panel rendering.

`testing/mockLLM.ts` provides two scripted models:

- `createMockFetch(script)`, which stands in for `fetch` in unit tests;
- `mockServerHandler(script)`, which goes behind a Node HTTP server to drive
  the real app end to end.
