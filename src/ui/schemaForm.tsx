import { Field, FieldDescription, FieldLabel } from '@tecton/react/components/field';
import { Input } from '@tecton/react/components/input';
import { Switch } from '@tecton/react/components/switch';
import { Textarea } from '@tecton/react/components/textarea';
import { useEffect, useId, useState } from 'react';
import { CompactSelect } from './controls';

/**
 * A form for a plugin's options, drawn from the JSON Schema of its Zod
 * schema: every transport, format and step — built in or custom — gets its
 * form without writing one. Text, numbers, switches, choices, lists
 * ("GR, RT"), name → value maps (one "name = value" per line) and, for
 * anything else, JSON.
 */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  additionalProperties?: JsonSchema | boolean;
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  pattern?: string;
  format?: string;
  /** display labels for `enum` values (set by the form, not by schemas) */
  labels?: { id: string; label: string }[];
}

type Value = Record<string, unknown>;

const SECRET = /token|password|secret|apikey|api_key/i;
const MONO = /expression|pattern|url|path|schema|topic|uri|query|body/i;

export const humanize = (k: string) =>
  k
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\b(url|md|uri|qos|id|tls|ssl)\b/gi, (m) => m.toUpperCase());

/** The options a schema produces with nothing filled in (its defaults). */
export function defaults(s: JsonSchema | undefined): Value {
  const out: Value = {};
  for (const [k, p] of Object.entries(s?.properties ?? {})) if (p.default !== undefined) out[k] = structuredClone(p.default);
  return out;
}

function choices(p: JsonSchema): { id: string; label: string; value: unknown }[] | null {
  if (p.labels) return p.labels.map((c) => ({ ...c, value: c.id }));
  if (p.enum) return p.enum.map((v) => ({ id: String(v), label: String(v), value: v }));
  const alts = p.anyOf ?? p.oneOf;
  if (alts?.every((a) => a.const !== undefined)) return alts.map((a) => ({ id: String(a.const), label: String(a.const), value: a.const }));
  return null;
}

const kind = (p: JsonSchema): string => {
  if (choices(p)) return 'choice';
  const t = Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type;
  if (t === 'array' && (p.items?.type === 'string' || p.items?.type === 'number')) return p.items.type === 'number' ? 'numbers' : 'strings';
  if (t === 'object' && !p.properties && p.additionalProperties && typeof p.additionalProperties === 'object') {
    const v = p.additionalProperties;
    if (v.type === 'string' || v.type === 'number') return 'map';
  }
  if (p.anyOf?.some((a) => a.type === 'string')) return 'string';
  return t ?? 'json';
};

export function SchemaForm({
  schema,
  value,
  onChange,
  hide = [],
  compact,
  choices: fixed,
}: {
  schema: JsonSchema | undefined;
  value: Value;
  onChange: (v: Value) => void;
  hide?: string[];
  compact?: boolean;
  /** a list to choose from for a text field (e.g. the wells), instead of typing */
  choices?: Record<string, { id: string; label: string }[]>;
}) {
  const props = Object.entries(schema?.properties ?? {}).filter(([k, p]) => !hide.includes(k) && Object.keys(p).length > 0);
  if (!props.length) return null;
  const set = (k: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };
  return (
    <div className={`grid gap-x-4 gap-y-3 ${compact ? 'grid-cols-1' : 'grid-cols-1 @md:grid-cols-2'}`}>
      {props.map(([k, p]) => (
        <SchemaField
          key={k}
          name={k}
          schema={fixed?.[k] ? { ...p, enum: fixed[k].map((c) => c.id), labels: fixed[k] } : p}
          value={value[k] ?? p.default}
          required={schema?.required?.includes(k) && p.default === undefined}
          onChange={(v) => set(k, v)}
        />
      ))}
    </div>
  );
}

function SchemaField({ name, schema: p, value, onChange, required }: { name: string; schema: JsonSchema; value: unknown; onChange: (v: unknown) => void; required?: boolean }) {
  const id = useId();
  const k = kind(p);
  const label = (
    <FieldLabel htmlFor={id} className="type-label">
      {humanize(name)}
      {required && <span className="text-destructive"> *</span>}
    </FieldLabel>
  );
  const help = p.description ? <FieldDescription className="type-caption">{p.description}</FieldDescription> : null;
  if (k === 'boolean')
    return (
      <Field orientation="horizontal" className="items-start gap-3 @md:col-span-2">
        <Switch id={id} isSelected={!!value} onChange={onChange} aria-label={humanize(name)} />
        <div className="flex min-w-0 flex-col gap-0.5">
          {label}
          {help}
        </div>
      </Field>
    );
  const wide = k === 'map' || k === 'json' || MONO.test(name);
  return (
    <Field className={`gap-1 ${wide ? '@md:col-span-2' : ''}`}>
      {label}
      <Control id={id} name={name} kind={k} schema={p} value={value} onChange={onChange} />
      {help}
    </Field>
  );
}

function Control({ id, name, kind: k, schema: p, value, onChange }: { id: string; name: string; kind: string; schema: JsonSchema; value: unknown; onChange: (v: unknown) => void }) {
  const mono = MONO.test(name) ? 'font-mono text-xs' : '';
  switch (k) {
    case 'choice': {
      const opts = choices(p)!;
      return (
        <CompactSelect
          id={id}
          label={humanize(name)}
          appearance="field"
          value={String(value ?? '')}
          onChange={(v) => onChange(opts.find((o) => o.id === v)?.value)}
          options={opts.map((o) => ({ id: o.id, label: o.label }))}
          className="w-full min-w-0"
        />
      );
    }
    case 'number':
    case 'integer':
      return <NumberInput id={id} value={typeof value === 'number' ? value : undefined} integer={k === 'integer'} onChange={onChange} min={p.minimum ?? p.exclusiveMinimum} max={p.maximum} />;
    case 'strings':
    case 'numbers':
      return (
        <ListInput
          id={id}
          className={mono}
          value={Array.isArray(value) ? value.map(String) : []}
          onChange={(xs) => onChange(k === 'numbers' ? xs.map(Number).filter(Number.isFinite) : xs)}
          placeholder="comma separated"
        />
      );
    case 'map':
      return <MapInput id={id} value={(value as Record<string, unknown>) ?? {}} numeric={(p.additionalProperties as JsonSchema).type === 'number'} onChange={onChange} />;
    case 'string':
      return (
        <TextInput
          id={id}
          className={mono}
          type={SECRET.test(name) ? 'password' : 'text'}
          value={typeof value === 'string' ? value : ''}
          onChange={(v) => onChange(v)}
          placeholder={p.format === 'uri' ? 'https://…' : undefined}
        />
      );
    default:
      return <JsonInput id={id} value={value} onChange={onChange} />;
  }
}

// ------------------------------------------------------------------ inputs that keep their own text while typing

function TextInput({ id, value, onChange, type, className, placeholder }: { id: string; value: string; onChange: (v: string) => void; type?: string; className?: string; placeholder?: string }) {
  return (
    <Input
      id={id}
      type={type}
      value={value}
      placeholder={placeholder}
      autoComplete={type === 'password' ? 'off' : undefined}
      spellCheck={false}
      className={className}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function useDraft<T>(value: T, show: (v: T) => string) {
  const [text, setText] = useState(() => show(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(show(value));
  }, [value, focused]); // eslint-disable-line react-hooks/exhaustive-deps
  return { text, setText, focus: () => setFocused(true), blur: () => setFocused(false) };
}

function NumberInput({ id, value, onChange, integer, min, max }: { id: string; value: number | undefined; onChange: (v: number | undefined) => void; integer?: boolean; min?: number; max?: number }) {
  const d = useDraft(value, (v) => (v === undefined ? '' : String(v)));
  const bad = d.text.trim() !== '' && !Number.isFinite(Number(d.text));
  return (
    <Input
      id={id}
      inputMode={integer ? 'numeric' : 'decimal'}
      value={d.text}
      aria-invalid={bad || undefined}
      onFocus={d.focus}
      onBlur={d.blur}
      onChange={(e) => {
        d.setText(e.target.value);
        const t = e.target.value.trim();
        if (!t) return onChange(undefined);
        let n = Number(t);
        if (!Number.isFinite(n)) return;
        if (integer) n = Math.round(n);
        if (min !== undefined) n = Math.max(min, n);
        if (max !== undefined) n = Math.min(max, n);
        onChange(n);
      }}
      className="tabular-nums"
    />
  );
}

function ListInput({ id, value, onChange, className, placeholder }: { id: string; value: string[]; onChange: (v: string[]) => void; className?: string; placeholder?: string }) {
  const d = useDraft(value, (v) => v.join(', '));
  return (
    <Input
      id={id}
      value={d.text}
      placeholder={placeholder}
      className={className}
      spellCheck={false}
      onFocus={d.focus}
      onBlur={d.blur}
      onChange={(e) => {
        d.setText(e.target.value);
        onChange(
          e.target.value
            .split(/[,\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}

function MapInput({ id, value, onChange, numeric }: { id: string; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; numeric?: boolean }) {
  const d = useDraft(value, (v) =>
    Object.entries(v)
      .map(([k, x]) => `${k} = ${x}`)
      .join('\n'),
  );
  return (
    <Textarea
      id={id}
      rows={Math.min(6, Math.max(2, d.text.split('\n').length))}
      value={d.text}
      placeholder={numeric ? 'GR = 12.4' : 'name = value'}
      className="font-mono text-xs"
      spellCheck={false}
      onFocus={d.focus}
      onBlur={d.blur}
      onChange={(e) => {
        d.setText(e.target.value);
        const out: Record<string, unknown> = {};
        for (const line of e.target.value.split('\n')) {
          const i = line.search(/[=:]/);
          if (i <= 0) continue;
          const k = line.slice(0, i).trim();
          const v = line.slice(i + 1).trim();
          if (!k) continue;
          out[k] = numeric ? Number(v) : v;
        }
        onChange(out);
      }}
    />
  );
}

function JsonInput({ id, value, onChange }: { id: string; value: unknown; onChange: (v: unknown) => void }) {
  const d = useDraft(value, (v) => (v === undefined ? '' : JSON.stringify(v, null, 1)));
  const [bad, setBad] = useState(false);
  return (
    <Textarea
      id={id}
      rows={3}
      value={d.text}
      aria-invalid={bad || undefined}
      className="font-mono text-xs"
      spellCheck={false}
      onFocus={d.focus}
      onBlur={d.blur}
      onChange={(e) => {
        d.setText(e.target.value);
        if (!e.target.value.trim()) return (setBad(false), onChange(undefined));
        try {
          onChange(JSON.parse(e.target.value));
          setBad(false);
        } catch {
          setBad(true);
        }
      }}
    />
  );
}
