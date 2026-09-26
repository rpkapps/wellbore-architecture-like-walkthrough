/*
 * A2UI v0.9 (and v0.9.1) wire types, as this kit reads them. The shapes follow
 * `specification/v0_9_1/json/*.json` and the basic catalog; every value that
 * arrives from a model is still treated as `unknown` until the processor has
 * checked it, so these types describe what a well-formed stream looks like.
 */

/** The basic catalog's id, as the catalog itself declares it (and as the samples use it). */
export const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';
/** The same catalog under the v0.9.1 path, used once by the protocol doc: accepted as an alias. */
export const BASIC_CATALOG_ID_091 = 'https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json';
/** This kit's data catalog: the basic catalog plus charts, depth profiles, tables, metrics and callouts. */
export const DATA_CATALOG_ID = 'urn:assistant-kit:catalog:data:v1';
/** Every catalog id a surface may name. */
export const SUPPORTED_CATALOG_IDS = [DATA_CATALOG_ID, BASIC_CATALOG_ID, BASIC_CATALOG_ID_091] as const;

export type A2UIVersion = 'v0.9' | 'v0.9.1';

// ------------------------------------------------------------------ dynamic values

/** A binding to the surface's data model: an absolute JSON Pointer, or a path relative to the template item. */
export interface DataBinding {
  path: string;
}

/** A client-side function call (`formatNumber`, `required`, `and`…). */
export interface FunctionCall {
  call: string;
  args?: Record<string, unknown>;
  returnType?: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any' | 'void';
}

export type DynamicValue<T> = T | DataBinding | FunctionCall;
export type DynamicString = DynamicValue<string>;
export type DynamicNumber = DynamicValue<number>;
export type DynamicBoolean = DynamicValue<boolean>;
export type DynamicStringList = DynamicValue<string[]>;

/** Children of a Row, Column or List: static ids, or one template repeated over a data-model array. */
export type ChildList = string[] | { componentId: string; path: string };

export interface CheckRule {
  condition: DynamicBoolean;
  message: string;
}

/** What a Button does: send an event to the agent, or run a local function (`openUrl`). */
export type Action = { event: { name: string; context?: Record<string, unknown> } } | { functionCall: FunctionCall };

// ------------------------------------------------------------------ components

/**
 * One node of a surface's adjacency list: `{ id, component: "Text", …props }`.
 * The props depend on the component type (see `catalog/schema.ts`).
 */
export interface A2UIComponent {
  id: string;
  component: string;
  accessibility?: { label?: DynamicString; description?: DynamicString };
  /** flex-grow inside a Row or Column */
  weight?: number;
  [prop: string]: unknown;
}

// ------------------------------------------------------------------ messages

export interface CreateSurface {
  surfaceId: string;
  catalogId: string;
  theme?: Record<string, unknown>;
  sendDataModel?: boolean;
}

export interface UpdateComponents {
  surfaceId: string;
  components: A2UIComponent[];
}

export interface UpdateDataModel {
  surfaceId: string;
  /** JSON Pointer; `/` or absent means the whole model */
  path?: string;
  /** absent: remove the key at `path` */
  value?: unknown;
}

export interface DeleteSurface {
  surfaceId: string;
}

export type A2UIMessage =
  | { version: A2UIVersion; createSurface: CreateSurface }
  | { version: A2UIVersion; updateComponents: UpdateComponents }
  | { version: A2UIVersion; updateDataModel: UpdateDataModel }
  | { version: A2UIVersion; deleteSurface: DeleteSurface };

export type A2UIMessageKind = 'createSurface' | 'updateComponents' | 'updateDataModel' | 'deleteSurface';
export const MESSAGE_KINDS: readonly A2UIMessageKind[] = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'];

// ------------------------------------------------------------------ client → server

/** The v0.9 client `action` event (a Button press), with its context resolved against the data model. */
export interface A2UIClientAction {
  version: A2UIVersion;
  action: {
    name: string;
    surfaceId: string;
    sourceComponentId: string;
    /** ISO 8601 */
    timestamp: string;
    context: Record<string, unknown>;
  };
}

// ------------------------------------------------------------------ processed state

/** One surface after the messages were applied: what the renderer draws. */
export interface SurfaceState {
  id: string;
  catalogId: string;
  theme?: Record<string, unknown>;
  sendDataModel: boolean;
  /** the adjacency list, by id (last definition wins) */
  components: Record<string, A2UIComponent>;
  /** the root component's id (`root`; a v0.8 `beginRendering` may name another), or null until it has arrived */
  rootId: string | null;
  dataModel: unknown;
  /** ids of components that may still be arriving (the last one of a streaming message) */
  pending: string[];
  /** bumps whenever a message touched this surface, so views can memoise on it */
  revision: number;
}
