import type { ReactNode } from 'react';

/*
 * The assistant kit's contracts. Everything under `src/assistant/` depends on
 * these types and on nothing of the host app: a project copies the folder,
 * implements an `AssistantHost`, and mounts `<AssistantPanel host={…} />`.
 *
 *   host (app)  ──tools, context, knowledge──▶  AgentSession (core/agent.ts)
 *                                                  │  stream(ModelRequest)
 *                                                  ▼
 *                                              ProviderAdapter (providers/*)
 *                                                  │  fetch + SSE, no SDKs
 *                                                  ▼
 *                                   OpenAI-compatible · Anthropic · Gemini
 *
 * The transcript is a list of `ChatMessage`s made of typed parts; the UI
 * renders parts, the adapters translate them to each provider's wire format.
 */

// ------------------------------------------------------------------ JSON

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** A JSON Schema object (draft 2020-12 subset every provider accepts). */
export type JSONSchema = { [key: string]: unknown };

// ------------------------------------------------------------------ transcript

export type Role = 'user' | 'assistant';

export interface TextPart {
  type: 'text';
  text: string;
}

/** The model's visible thinking (Anthropic thinking, DeepSeek/OpenRouter `reasoning_content`, Gemini thoughts). */
export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  /** Anthropic: the signature that must accompany the thinking block when it is sent back */
  signature?: string;
  /** Anthropic: an encrypted `redacted_thinking` block, replayed as is */
  redacted?: string;
  /** how long the model thought, once the next part started */
  durationMs?: number;
  /** provider-specific data replayed with the part, namespaced by provider kind (`{ gemini: { thoughtSignature } }`) */
  providerMeta?: Record<string, unknown>;
}

/** An image the user attached (or a capture of the app's view): sent to vision models. */
export interface ImagePart {
  type: 'image';
  /** e.g. image/png */
  mediaType: string;
  /** base64, without the `data:` prefix */
  data: string;
  name?: string;
}

/** A text file the user attached (CSV, LAS, JSON…): inlined into the prompt. */
export interface FilePart {
  type: 'file';
  name: string;
  mediaType: string;
  text: string;
  /** the file was longer than the kit sends; `text` is its head */
  truncated?: boolean;
}

/**
 * App context attached to a user message (the selected object, the open
 * well…): shown as chips on the message, sent to the model as a
 * `<context>` block before the text.
 */
export interface ContextPart {
  type: 'context';
  items: ContextItem[];
  /**
   * The app's state and the conversation's datasets when the message was
   * sent (`core/systemPrompt.ts` → `buildTurnState`): sent to the model
   * before the text, never shown. Kept with the message rather than in the
   * system prompt, so the prompt stays the same from turn to turn and the
   * transcript only ever grows (prompt caches and replayed thinking stay valid).
   */
  state?: string;
}

export type ToolCallState =
  /** arguments are still streaming in */
  | 'streaming'
  /** waiting for the person to approve or deny it */
  | 'awaiting-approval'
  | 'running'
  | 'done'
  | 'error'
  | 'denied'
  /** the turn was stopped before it ran or finished */
  | 'cancelled';

export interface ToolCallPart {
  type: 'tool-call';
  /** the provider's call id (unique within the thread) */
  id: string;
  /** the tool's kit name (`AssistantTool.name`), not the sanitised wire name */
  name: string;
  /** the parsed arguments (partial while streaming) */
  args: unknown;
  /** the raw argument JSON as streamed */
  argsText?: string;
  state: ToolCallState;
  /** what the model was told (after dataset extraction and truncation) */
  result?: unknown;
  error?: string;
  /** datasets the call produced (their ids; the rows live in `Thread.datasets`) */
  datasets?: string[];
  startedAt?: number;
  endedAt?: number;
  /** provider-specific data replayed with the call, namespaced by provider kind (`{ gemini: { thoughtSignature } }`) */
  providerMeta?: Record<string, unknown>;
}

/**
 * A generated interface: A2UI server-to-client messages, rendered as a live
 * surface in the transcript (see `a2ui/`). Produced by the built-in
 * `render_ui` tool, or from an ```a2ui fenced block in the text.
 */
export interface UIPart {
  type: 'ui';
  /** stable id of the part (the tool call id, or `<messageId>:fence:<n>`) */
  id: string;
  /** A2UI messages, in order (`a2ui/types.ts`) */
  messages: unknown[];
  /** the render_ui call that produced it */
  toolCallId?: string;
}

/**
 * A person's interaction with a generated interface (a button press, a form
 * submit): an A2UI `userAction`, sent to the model as the next user turn.
 */
export interface UIEventPart {
  type: 'ui-event';
  surfaceId: string;
  /** the action's name, as the surface declared it */
  name: string;
  sourceComponentId?: string;
  /** resolved action context (bound data-model values) */
  context?: Record<string, unknown>;
  /** a short human label for the transcript ("Pressed “Go to top of Hugin”") */
  label?: string;
}

export interface ErrorPart {
  type: 'error';
  message: string;
  /** e.g. the HTTP status and the provider's error body */
  detail?: string;
  /** a retry may succeed (rate limit, network, overload) */
  retryable?: boolean;
  /** the settings are wrong (no key, bad key, unknown model): the UI offers Settings */
  config?: boolean;
}

export type Part = TextPart | ReasoningPart | ImagePart | FilePart | ContextPart | ToolCallPart | UIPart | UIEventPart | ErrorPart;

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error';

export interface ChatMessage {
  id: string;
  role: Role;
  parts: Part[];
  createdAt: number;
  /** assistant: which provider preset and model wrote it */
  provider?: string;
  model?: string;
  usage?: Usage;
  status?: MessageStatus;
  finishReason?: FinishReason;
}

// ------------------------------------------------------------------ datasets

/**
 * Tabular data a tool produced (log samples, production history, a table of
 * tops). The rows stay in the browser: the model is told the dataset's id,
 * columns, size, a few sample rows and per-column statistics, and a chart or
 * table in a generated interface binds to the id. So a chart of 5,000 log
 * samples costs the model a few hundred tokens and plots every sample.
 */
export interface DatasetColumn {
  key: string;
  label?: string;
  unit?: string;
  type?: 'number' | 'string' | 'date' | 'boolean';
}

export type DatasetRow = Record<string, number | string | boolean | null>;

export interface Dataset {
  /** assigned by the kit when a tool returns it (`ds_1`, `ds_2`…), unique within the thread */
  id: string;
  title: string;
  columns: DatasetColumn[];
  rows: DatasetRow[];
  /** where it came from, in words ("Well 15/9-F-11 A · GR, 3000–3100 m MD") */
  source?: string;
  createdAt: number;
}

/** What a tool returns to hand over datasets: `content` is what the model reads. */
export interface ToolOutput {
  /** what the model is told (keep it small: the datasets are summarised separately) */
  content: Json | undefined;
  datasets?: Omit<Dataset, 'id' | 'createdAt'>[];
}

// ------------------------------------------------------------------ tools

export interface ToolContext {
  signal: AbortSignal;
  toolCallId: string;
  /** the datasets of the current thread, by id (to read one a previous call produced) */
  datasets: ReadonlyMap<string, Dataset>;
}

export interface AssistantTool {
  /**
   * The kit name, e.g. `view.color_by`. Any characters; the kit maps it to a
   * provider-safe wire name (`^[a-zA-Z0-9_-]{1,64}$`) and back.
   */
  name: string;
  /** for people: the transcript's "Ran <title>" */
  title?: string;
  /** for the model: what it does and when to use it */
  description: string;
  /** a JSON Schema of type object */
  parameters: JSONSchema;
  /**
   * Reads only: never needs approval, and the UI groups such calls quietly.
   * Tools that change the app are `write` (the default).
   */
  kind?: 'read' | 'write';
  /**
   * Changes or removes the person's data: always asks, even in the
   * "act without asking" mode.
   */
  needsApproval?: boolean | ((args: unknown) => boolean);
  /**
   * Runs the tool. Return plain JSON, or a `ToolOutput` to hand over
   * datasets. Throw to report an error to the model (it can correct itself).
   */
  execute: (args: unknown, ctx: ToolContext) => unknown | Promise<unknown>;
}

// ------------------------------------------------------------------ host

/** One piece of app context: a chip on the composer and on the sent message. */
export interface ContextItem {
  /** stable id (`selection:formation:hugin`): a removed chip stays removed while its id is current */
  id: string;
  /** chip text ("Hugin Fm.") */
  label: string;
  /** chip tooltip / second line ("Selected formation") */
  description?: string;
  /** what the model is told: any JSON, serialised into the `<context>` block */
  data: Json;
  /** an icon name the host's `renderIcon` understands, or none */
  icon?: string;
}

export interface Suggestion {
  /** the button text */
  label: string;
  /** what is sent (defaults to the label) */
  prompt?: string;
  /** a second line on the empty state's suggestion cards */
  description?: string;
  icon?: string;
}

/**
 * What an app gives the assistant. The only app-specific code: everything
 * else under `src/assistant/` is generic.
 */
export interface AssistantHost {
  /** "BoreWalk": the assistant introduces itself as the app's assistant */
  appName: string;
  /**
   * Domain knowledge and house rules for the system prompt: what the app
   * is, its vocabulary, how to answer. Read at the start of every turn.
   */
  instructions: () => string;
  /**
   * The tools the model may call, read at the start of every step (the set
   * may change with the app's state). The kit adds its own (`render_ui`,
   * `query_dataset`).
   */
  tools: () => AssistantTool[];
  /** The context attached to the next message (the selection, the open well), read when the composer renders and on send. */
  context?: () => ContextItem[];
  /** Called when the context may have changed; returns an unsubscribe. */
  subscribeContext?: (onChange: () => void) => () => void;
  /** A short live snapshot of the app for the system prompt of every step (the open well, the camera depth…). */
  snapshot?: () => Json;
  /** Prompts for the empty state and the composer, from the current context. */
  suggestions?: () => Suggestion[];
  /** A picture of the app's main view (the 3D canvas), attached with the camera button. */
  captureView?: () => Promise<{ mediaType: string; data: string } | null>;
  /** Icons for context chips and suggestions, by name. */
  renderIcon?: (name: string) => ReactNode;
  /** Called when the person presses an app link in an answer (`app://…` markdown links), e.g. to run an action. */
  onLink?: (href: string) => void;
  /** Storage namespace for threads and settings (defaults to the app name). */
  storageKey?: string;
}

// ------------------------------------------------------------------ providers

/** The three wire protocols; every other provider speaks one of them. */
export type ProviderKind = 'openai' | 'anthropic' | 'gemini';

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

/** One configured connection (a preset filled in by the person). Stored in localStorage. */
export interface ProviderConfig {
  /** unique id of this connection */
  id: string;
  /** the preset it was made from (`openai`, `deepseek`, `ollama`, `custom`…) */
  presetId: string;
  /** what the model picker shows ("DeepSeek") */
  label: string;
  kind: ProviderKind;
  /** e.g. https://api.deepseek.com/v1 (no trailing slash) */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** extra request headers (OpenRouter's HTTP-Referer, an org id…) */
  headers?: Record<string, string>;
  temperature?: number;
  maxOutputTokens?: number;
  reasoning?: ReasoningEffort;
  /**
   * A URL prefix for providers that refuse browser (CORS) requests:
   * `https://my-proxy.example/` + the request URL.
   */
  corsProxy?: string;
  /** the model can call tools (off: the assistant only answers) */
  tools?: boolean;
  /** the model accepts images */
  vision?: boolean;
}

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  /** model ids offered before the list is fetched; the first is the default */
  models: string[];
  /** where to get a key, for the settings form */
  keyUrl?: string;
  /** a key is required (local servers need none) */
  needsKey: boolean;
  /** placeholder of the key field ("sk-…") */
  keyHint?: string;
  headers?: Record<string, string>;
  /** a note under the form (CORS, local server flags) */
  note?: string;
  vision?: boolean;
}

export interface ModelInfo {
  id: string;
  label?: string;
  contextWindow?: number;
}

/** A tool as sent to a provider. */
export interface WireTool {
  /** sanitised: ^[a-zA-Z0-9_-]{1,64}$ */
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface ModelRequest {
  config: ProviderConfig;
  system: string;
  /**
   * The transcript to send, in kit form. Adapters translate: `context`,
   * `file` and `ui-event` parts become text, `ui` parts are skipped (their
   * `render_ui` call and result carry them), tool calls and their results
   * become the provider's tool messages. Tool names are already wire names.
   */
  messages: ChatMessage[];
  tools: WireTool[];
  signal: AbortSignal;
}

export type FinishReason = 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error' | 'other';

/** What an adapter yields while a response streams. */
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  /** Anthropic: the thinking block's signature, at its end */
  | { type: 'reasoning-signature'; signature: string }
  | { type: 'reasoning-redacted'; data: string }
  | { type: 'tool-call-start'; id: string; name: string; providerMeta?: Record<string, unknown> }
  | { type: 'tool-call-delta'; id: string; argsText: string }
  /** the call is complete; `args` parsed (`{}` for empty), or `argsError` when the JSON was invalid */
  | { type: 'tool-call-end'; id: string; args: unknown; argsError?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: FinishReason };

export interface ProviderAdapter {
  kind: ProviderKind;
  /** Streams one model response. Throws a `ProviderError` on HTTP or protocol errors. */
  stream: (req: ModelRequest) => AsyncIterable<StreamEvent>;
  /** Lists the models the key can use (for the model picker). */
  listModels?: (config: ProviderConfig, signal?: AbortSignal) => Promise<ModelInfo[]>;
}

// ------------------------------------------------------------------ session

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** datasets produced in this thread, by id */
  datasets: Record<string, Dataset>;
}

/** The composer's status, as `@tecton/react/tecton/composer` expects it. */
export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error';

/**
 * How much the assistant may do on its own. `ask`: every app-changing tool
 * call waits for approval. `auto`: only those marked `needsApproval` wait.
 * `read`: the assistant can only look (write tools are not offered).
 */
export type AutonomyMode = 'read' | 'ask' | 'auto';

export interface AssistantSettings {
  providers: ProviderConfig[];
  /** the connection in use */
  activeProviderId: string | null;
  autonomy: AutonomyMode;
  /** keep API keys in localStorage (off: this browser session only) */
  rememberKeys: boolean;
  /** most model round-trips per turn before the agent stops and asks */
  maxSteps: number;
  /** show the model's reasoning in the transcript */
  showReasoning: boolean;
}

/** What the person sends. */
export interface OutgoingMessage {
  text: string;
  context?: ContextItem[];
  images?: ImagePart[];
  files?: FilePart[];
}

/**
 * The state the UI renders (from `useAssistant`, an external store: each
 * snapshot is immutable, unchanged messages keep their identity so rows can
 * be memoised).
 */
export interface AssistantSnapshot {
  thread: Thread;
  /** all threads, newest first, without their messages */
  threads: Pick<Thread, 'id' | 'title' | 'createdAt' | 'updatedAt'>[];
  status: ChatStatus;
  /** tool calls waiting for the person, oldest first */
  pendingApprovals: ToolCallPart[];
  settings: AssistantSettings;
  /** the active connection, or null when none is set up */
  provider: ProviderConfig | null;
  /** the last error of the session (also in the transcript as an ErrorPart) */
  error: ErrorPart | null;
}

/** What the UI can do (from `useAssistant`). */
export interface AssistantController {
  getSnapshot: () => AssistantSnapshot;
  subscribe: (listener: () => void) => () => void;
  send: (message: OutgoingMessage) => void;
  stop: () => void;
  /** answer a tool call waiting for approval; `always` approves this tool for the rest of the thread */
  approve: (toolCallId: string, approved: boolean, opts?: { always?: boolean }) => void;
  /** send an A2UI userAction as the next user turn */
  uiAction: (event: Omit<UIEventPart, 'type'>) => void;
  /** drop the last assistant turn and ask again */
  regenerate: () => void;
  /** edit a user message: the transcript after it is dropped and the edited text is sent */
  editAndResend: (messageId: string, text: string) => void;
  newThread: () => void;
  openThread: (id: string) => void;
  deleteThread: (id: string) => void;
  renameThread: (id: string, title: string) => void;
  updateSettings: (patch: Partial<AssistantSettings>) => void;
  /** add or replace a connection (by id) */
  saveProvider: (config: ProviderConfig) => void;
  removeProvider: (id: string) => void;
  /** quick round-trip to check a connection: resolves with the reply text or rejects with a ProviderError */
  testProvider: (config: ProviderConfig) => Promise<string>;
  listModels: (config: ProviderConfig) => Promise<ModelInfo[]>;
  /** the thread as Markdown, for export */
  exportMarkdown: (threadId?: string) => string;
  host: AssistantHost;
}
