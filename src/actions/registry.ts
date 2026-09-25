import type { ReactNode } from 'react';
import { z } from 'zod';
import { selectionInput, type Selection, type SelectionKind } from '../ui/selection';

/**
 * Every operation a person can do in the app, described once: the command
 * palette lists and runs these, the keyboard shortcuts name them, and an AI
 * assistant can later call the same actions as tools (see `tanstack.ts`).
 *
 * An action is plain data plus a `run` function: an id that doubles as the
 * tool name, a title for people, a description for the model, an optional
 * Zod (v4) input schema, and whether it needs the person's approval first.
 */
export type ActionCategory = 'Navigate' | 'View' | 'Panels' | 'Workspace' | 'Scene' | 'Interpretation' | 'Features' | 'Data' | 'Preferences' | 'Help';

/** Arguments as the palette or a model sends them; checked against the action's schema before it runs. */
export type ActionInput = Record<string, unknown>;

export interface ActionChoice<I> {
  /** shown in the palette after the action's title ("Colour by → Resistivity") */
  label: string;
  input: I;
  keywords?: string[];
  /** ticked in the palette: the current value */
  current?: boolean;
}

export interface Action<S extends z.ZodType = z.ZodType, Ctx = unknown> {
  /** stable id and tool name: letters, digits, `_` `.` `-` (e.g. `view.color_by`) */
  id: string;
  title: string;
  /** what it does, for the palette's subtitle and for a model choosing tools */
  description: string;
  category: ActionCategory;
  /** the arguments; omitted for actions that take none */
  input?: S;
  keywords?: string[];
  /** the key that runs it, as shown in the palette (the binding itself lives with the key handler) */
  shortcut?: string;
  icon?: ReactNode;
  /** for tools only (reading the app's state): not listed in the palette */
  hidden?: boolean;
  /** changes or removes the person's data: an assistant must ask before running it */
  needsApproval?: boolean;
  /** whether it can run right now (a well without logs cannot be interpreted) */
  enabled?: (ctx: Ctx) => boolean;
  /**
   * For the palette: ready-made arguments, each listed as its own entry
   * (every property mode, every well). Actions with free-form input and no
   * choices are listed once and ask for their arguments with `prompt`.
   */
  choices?: (ctx: Ctx) => ActionChoice<ActionInput>[];
  /** a single typed argument asked for in the palette ("Go to depth → 3,200") */
  prompt?: { label: string; placeholder?: string; parse: (text: string, ctx: Ctx) => ActionInput | null };
  /**
   * The kinds of selected object it acts on, like a VS Code when-clause: the
   * right-click menus, Properties and (later) the task bar list it for them,
   * with the selected object filled in as its input.
   */
  appliesTo?: SelectionKind[];
  /**
   * How it acts on one selected object. By convention the input is the
   * object's id under its kind (`{ formation: 'hugin' }`, `{ well: id }`,
   * see `selectionInput`); return another `input` when the schema is shaped
   * differently, a `label` for the menu ("Hide" rather than the title), and
   * `checked` for a toggle that is on. Return null when it does not apply to
   * this particular object (opening the well that is already open).
   */
  onSelection?: (sel: Selection, ctx: Ctx) => SelectionBinding | null;
  run: (ctx: Ctx, input: NoInfer<z.output<S>>) => unknown | Promise<unknown>;
}

/** What `onSelection` returns: the input for the selected object and how its menu entry reads. */
export interface SelectionBinding {
  input?: ActionInput;
  label?: string;
  checked?: boolean;
}

/** An action ready to run on the selected object: a right-click menu entry. */
export interface SelectionEntry<Ctx> {
  action: AnyAction<Ctx>;
  /** the menu label: the action's own for this object, or its title */
  label: string;
  input: ActionInput | undefined;
  checked?: boolean;
  run: () => Promise<RunResult>;
}

export type AnyAction<Ctx> = Action<z.ZodType, Ctx>;

export type RunResult = { ok: true; result: unknown } | { ok: false; error: string };

/** Defines an action with its input type inferred from the schema. */
export function defineAction<Ctx, S extends z.ZodType = z.ZodUndefined>(a: Action<S, Ctx>): AnyAction<Ctx> {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(a.id)) throw new Error(`action id "${a.id}" is not a valid tool name`);
  return a as unknown as AnyAction<Ctx>;
}

/** The actions of one app, looked up by id and run with validated input. */
export class ActionRegistry<Ctx> {
  private map = new Map<string, AnyAction<Ctx>>();
  private listeners = new Set<(id: string, input: unknown, r: RunResult) => void>();

  constructor(readonly ctx: Ctx) {}

  register(...actions: AnyAction<Ctx>[]) {
    for (const a of actions) {
      if (this.map.has(a.id)) throw new Error(`action "${a.id}" is registered twice`);
      this.map.set(a.id, a);
    }
    return this;
  }

  get(id: string) {
    return this.map.get(id);
  }

  list(): AnyAction<Ctx>[] {
    return [...this.map.values()];
  }

  enabled(a: AnyAction<Ctx>) {
    try {
      return a.enabled?.(this.ctx) ?? true;
    } catch {
      return false;
    }
  }

  /** Run an action by id. The input is validated against its schema; errors come back as values, never thrown. */
  async run(id: string, input?: unknown): Promise<RunResult> {
    const a = this.map.get(id);
    let r: RunResult;
    if (!a) r = { ok: false, error: `No action "${id}".` };
    else if (!this.enabled(a)) r = { ok: false, error: `“${a.title}” is not available right now.` };
    else {
      const parsed = a.input ? a.input.safeParse(input) : { success: true as const, data: undefined };
      if (!parsed.success) r = { ok: false, error: `Invalid input for ${id}: ${z.prettifyError(parsed.error)}` };
      else {
        try {
          r = { ok: true, result: (await a.run(this.ctx, parsed.data)) ?? null };
        } catch (err) {
          r = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    }
    for (const l of this.listeners) l(id, input, r);
    return r;
  }

  /**
   * The actions that apply to a selected object, in registration order, each
   * with its input filled in: those whose `appliesTo` names the selection's
   * kind, that can run now, that do not decline this object and whose input
   * passes their schema. Right-click menus, Properties and the task bar list these.
   */
  actionsFor(sel: Selection | null): SelectionEntry<Ctx>[] {
    if (!sel) return [];
    const out: SelectionEntry<Ctx>[] = [];
    for (const a of this.map.values()) {
      if (!a.appliesTo?.includes(sel.kind) || !this.enabled(a)) continue;
      let b: SelectionBinding | null;
      try {
        b = a.onSelection ? a.onSelection(sel, this.ctx) : {};
      } catch {
        b = null;
      }
      if (!b) continue;
      const input = a.input ? (b.input ?? selectionInput(sel)) : undefined;
      if (a.input && !a.input.safeParse(input).success) continue;
      out.push({ action: a, label: b.label ?? a.title, input, checked: b.checked, run: () => this.run(a.id, input) });
    }
    return out;
  }

  /** Called after every run (a history, an assistant's transcript, analytics). */
  onRun(fn: (id: string, input: unknown, r: RunResult) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The actions as JSON Schema tool descriptions, for any model API. */
  describe() {
    return this.list().map((a) => ({
      name: a.id,
      description: `${a.title}. ${a.description}`,
      input_schema: a.input ? z.toJSONSchema(a.input) : { type: 'object', properties: {} },
      needsApproval: !!a.needsApproval,
      // the kinds of selected object it acts on (app.state names the selection)
      ...(a.appliesTo ? { appliesTo: a.appliesTo } : {}),
    }));
  }
}
