/*
 * The A2UI v0.9 basic catalog, drawn with Tecton components: layout (Row,
 * Column, List, Card, Tabs, Modal, Divider), content (Text, Image, Icon,
 * Video, AudioPlayer) and input (Button, TextField, CheckBox, ChoicePicker,
 * Slider, DateTimeInput). Inputs write straight into the surface's data
 * model; nothing reaches the agent until a Button sends an action.
 */
import { createContext, useContext, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '@tecton/react/components/button';
import { Card, CardContent } from '@tecton/react/components/card';
import { Checkbox } from '@tecton/react/components/checkbox';
import { Dialog, DialogHeader, DialogTitle } from '@tecton/react/components/dialog';
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet, FieldTitle } from '@tecton/react/components/field';
import { Input } from '@tecton/react/components/input';
import { RadioGroup, RadioGroupItem } from '@tecton/react/components/radio-group';
import { Separator } from '@tecton/react/components/separator';
import { Slider } from '@tecton/react/components/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@tecton/react/components/tabs';
import { Textarea } from '@tecton/react/components/textarea';
import { Chip, ChipGroup, ChipList } from '@tecton/react/tecton/chip';
import { cn } from 'cn';
import {
  ArrowLeft, ArrowRight, Bell, BellOff, Calendar, CalendarDays, Camera, Check, CircleAlert, CircleQuestionMark, CircleUser, CreditCard, Download, Ellipsis,
  EllipsisVertical, Eye, EyeOff, FastForward, Folder, Heart, HeartOff, House, Image as ImageIcon, Info, Lock, LockOpen, Mail, MapPin, Menu, Paperclip, Pause,
  Pencil, Phone, Play, Plus, Printer, RefreshCw, Rewind, Search, Send, Settings, Share2, ShoppingCart, SkipBack, SkipForward, Smartphone, Square, Star, StarHalf,
  StarOff, Trash, TriangleAlert, Upload, User, Volume, Volume1, Volume2, VolumeOff, X, type LucideIcon,
} from 'lucide-react';
import { BlockMarkdown, InlineMarkdown } from '../markdown';
import { evaluateCall, isFunctionCall, resolveText, resolveValue, toText } from '../functions';
import { getAt, resolvePath } from '../pointer';
import { useBound, useEval, useRuntime, useText, type NodeProps } from '../runtime';
import type { A2UIComponent } from '../types';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Inside a Button: Text renders inline, without block Markdown. */
const InlineContext = createContext(false);
/** Inside a Modal's trigger: the Button opens the dialog instead of sending its action. */
const TriggerContext = createContext<(() => void) | null>(null);

// ------------------------------------------------------------------ children

/** Renders a ChildList: static ids, or a template repeated over the array at `path`. */
export function Children({ list, scope, trail, wrap }: { list: unknown; scope: string; trail: readonly string[]; wrap?: (child: ReactNode, id: string, key: string) => ReactNode }) {
  const { Node, model, surface } = useRuntime();
  if (Array.isArray(list))
    return (
      <>
        {list.map((id, i) => {
          if (typeof id !== 'string') return null;
          const key = `${id}:${i}`;
          const child = <Node key={key} id={id} scope={scope} trail={trail} />;
          return wrap ? <WrapKey key={key}>{wrap(child, id, key)}</WrapKey> : child;
        })}
      </>
    );
  if (isRec(list) && typeof list.componentId === 'string' && typeof list.path === 'string') {
    const abs = resolvePath(list.path, scope);
    const items = getAt(model, abs);
    const keys = Array.isArray(items) ? items.map((_, i) => String(i)) : isRec(items) ? Object.keys(items) : [];
    const tpl = list.componentId;
    if (!surface.components[tpl]) return null;
    return (
      <>
        {keys.map((k) => {
          const itemScope = `${abs === '/' ? '' : abs}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`;
          const child = <Node key={k} id={tpl} scope={itemScope} trail={trail} />;
          return wrap ? <WrapKey key={k}>{wrap(child, tpl, k)}</WrapKey> : child;
        })}
      </>
    );
  }
  return null;
}

function WrapKey({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

const JUSTIFY: Record<string, string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  spaceBetween: 'justify-between',
  spaceAround: 'justify-around',
  spaceEvenly: 'justify-evenly',
  stretch: 'justify-stretch',
};
const ALIGN: Record<string, string> = { start: 'items-start', center: 'items-center', end: 'items-end', stretch: 'items-stretch' };

/** Wraps a Row/Column child; a `weight` becomes its flex-grow. */
function weightWrap(components: Record<string, A2UIComponent>) {
  return (child: ReactNode, id: string) => {
    const w = components[id]?.weight;
    if (typeof w !== 'number' || w <= 0) return <div className="min-w-0">{child}</div>;
    return (
      <div className="min-w-0" style={{ flexGrow: w, flexBasis: 0 } as CSSProperties}>
        {child}
      </div>
    );
  };
}

function Row({ node, scope, trail }: NodeProps) {
  const { surface } = useRuntime();
  return (
    <div className={cn('flex flex-wrap gap-3', JUSTIFY[String(node.justify)] ?? 'justify-start', ALIGN[String(node.align)] ?? 'items-stretch')}>
      <Children list={node.children} scope={scope} trail={trail} wrap={weightWrap(surface.components)} />
    </div>
  );
}

function Column({ node, scope, trail }: NodeProps) {
  const { surface } = useRuntime();
  return (
    <div className={cn('flex flex-col gap-3', JUSTIFY[String(node.justify)] ?? 'justify-start', ALIGN[String(node.align)] ?? 'items-stretch')}>
      <Children list={node.children} scope={scope} trail={trail} wrap={weightWrap(surface.components)} />
    </div>
  );
}

function List({ node, scope, trail }: NodeProps) {
  const horizontal = node.direction === 'horizontal';
  return (
    <div
      role="list"
      className={cn(
        horizontal ? 'flex gap-3 overflow-x-auto pb-1' : 'flex flex-col divide-y divide-border-subtle',
        ALIGN[String(node.align)] ?? 'items-stretch',
      )}
    >
      <Children
        list={node.children}
        scope={scope}
        trail={trail}
        wrap={(child) => (
          <div role="listitem" className={horizontal ? 'shrink-0' : 'py-2 first:pt-0 last:pb-0'}>
            {child}
          </div>
        )}
      />
    </div>
  );
}

function CardNode({ node, scope, trail }: NodeProps) {
  const { Node } = useRuntime();
  return (
    <Card size="sm">
      <CardContent>{typeof node.child === 'string' && <Node id={node.child} scope={scope} trail={trail} />}</CardContent>
    </Card>
  );
}

function TabsNode({ node, scope, trail }: NodeProps) {
  const { Node, model } = useRuntime();
  const tabs = Array.isArray(node.tabs) ? node.tabs.filter(isRec) : [];
  if (!tabs.length) return null;
  return (
    <Tabs defaultSelectedKey="0">
      <TabsList variant="line">
        {tabs.map((t, i) => (
          <TabsTrigger key={i} id={String(i)}>
            {resolveText(t.title, { model, scope }) || `Tab ${i + 1}`}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t, i) => (
        <TabsContent key={i} id={String(i)} className="pt-3">
          {typeof t.child === 'string' && <Node id={t.child} scope={scope} trail={trail} />}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function Modal({ node, scope, trail }: NodeProps) {
  const { Node, surface, model } = useRuntime();
  const [open, setOpen] = useState(false);
  const trigger = typeof node.trigger === 'string' ? node.trigger : null;
  const triggerNode = trigger ? surface.components[trigger] : undefined;
  const title = resolveText(node.accessibility?.label, { model, scope }) || buttonLabel(triggerNode, surface.components, { model, scope }) || 'Details';
  return (
    <>
      <TriggerContext.Provider value={() => setOpen(true)}>
        {triggerNode?.component === 'Button' ? (
          <Node id={trigger!} scope={scope} trail={trail} />
        ) : trigger ? (
          <Button variant="outline" onPress={() => setOpen(true)}>
            <InlineContext.Provider value>
              <Node id={trigger} scope={scope} trail={trail} />
            </InlineContext.Provider>
          </Button>
        ) : null}
      </TriggerContext.Provider>
      <Dialog isOpen={open} onOpenChange={setOpen} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto">{typeof node.content === 'string' && <Node id={node.content} scope={scope} trail={trail} />}</div>
      </Dialog>
    </>
  );
}

function Divider({ node }: NodeProps) {
  const vertical = node.axis === 'vertical';
  return <Separator orientation={vertical ? 'vertical' : 'horizontal'} className={vertical ? 'self-stretch' : 'my-1'} />;
}

// ------------------------------------------------------------------ content

const TEXT_CLASS: Record<string, string> = {
  h1: 'text-xl font-semibold tracking-tight text-foreground',
  h2: 'text-lg font-semibold tracking-tight text-foreground',
  h3: 'text-base font-semibold text-foreground',
  h4: 'text-sm font-semibold text-foreground',
  h5: 'text-xs font-semibold uppercase tracking-wide text-muted-foreground',
  caption: 'text-xs text-muted-foreground',
  body: 'text-sm leading-relaxed text-foreground',
};

function Text({ node, scope }: NodeProps) {
  const inline = useContext(InlineContext);
  const text = useText(node.text, scope);
  const variant = typeof node.variant === 'string' && TEXT_CLASS[node.variant] ? node.variant : 'body';
  if (inline) return <InlineMarkdown text={text} />;
  const heading = /^h[1-5]$/.test(variant);
  return (
    <div className={cn(TEXT_CLASS[variant], 'min-w-0 break-words')} role={heading ? 'heading' : undefined} aria-level={heading ? Number(variant[1]) + 1 : undefined}>
      {heading ? <InlineMarkdown text={text} /> : <BlockMarkdown text={text} />}
    </div>
  );
}

/** http(s), data:image and relative URLs; nothing that could run script. */
export function safeUrl(url: string, kind: 'image' | 'media' = 'image'): string | null {
  const u = url.trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u) || /^blob:/i.test(u)) return u;
  if (kind === 'image' && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(u)) return u;
  if (/^(\/|\.\/|\.\.\/)/.test(u) || /^[\w-]+(\/[\w.-]+)*\.\w{2,5}$/.test(u)) return u;
  return null;
}

const IMAGE_CLASS: Record<string, string> = {
  icon: 'size-6 rounded',
  avatar: 'size-10 rounded-full',
  smallFeature: 'size-20 rounded-md',
  mediumFeature: 'w-full max-h-48 rounded-md',
  largeFeature: 'w-full max-h-80 rounded-lg',
  header: 'h-36 w-full rounded-lg',
};
const FIT: Record<string, string> = { contain: 'object-contain', cover: 'object-cover', fill: 'object-fill', none: 'object-none', scaleDown: 'object-scale-down' };

function ImageNode({ node, scope }: NodeProps) {
  const url = safeUrl(useText(node.url, scope));
  const alt = useText(node.description, scope);
  const variant = typeof node.variant === 'string' && IMAGE_CLASS[node.variant] ? node.variant : 'mediumFeature';
  const fit = typeof node.fit === 'string' && FIT[node.fit] ? FIT[node.fit] : variant === 'avatar' || variant === 'header' ? 'object-cover' : 'object-contain';
  if (!url) return null;
  return <img src={url} alt={alt} loading="lazy" className={cn(IMAGE_CLASS[variant], fit, 'bg-muted')} />;
}

const ICONS: Record<string, LucideIcon> = {
  accountCircle: CircleUser, add: Plus, arrowBack: ArrowLeft, arrowForward: ArrowRight, attachFile: Paperclip, calendarToday: Calendar, call: Phone, camera: Camera,
  check: Check, close: X, delete: Trash, download: Download, edit: Pencil, event: CalendarDays, error: CircleAlert, fastForward: FastForward, favorite: Heart,
  favoriteOff: HeartOff, folder: Folder, help: CircleQuestionMark, home: House, info: Info, locationOn: MapPin, lock: Lock, lockOpen: LockOpen, mail: Mail, menu: Menu,
  moreVert: EllipsisVertical, moreHoriz: Ellipsis, notificationsOff: BellOff, notifications: Bell, pause: Pause, payment: CreditCard, person: User, phone: Smartphone,
  photo: ImageIcon, play: Play, print: Printer, refresh: RefreshCw, rewind: Rewind, search: Search, send: Send, settings: Settings, share: Share2,
  shoppingCart: ShoppingCart, skipNext: SkipForward, skipPrevious: SkipBack, star: Star, starHalf: StarHalf, starOff: StarOff, stop: Square, upload: Upload,
  visibility: Eye, visibilityOff: EyeOff, volumeDown: Volume1, volumeMute: Volume, volumeOff: VolumeOff, volumeUp: Volume2, warning: TriangleAlert,
};

/** A basic-catalog icon name as a Lucide icon (unknown names get none). */
export function iconFor(name: string): LucideIcon | undefined {
  return ICONS[name];
}

function IconNode({ node, scope }: NodeProps) {
  const ctx = useEval(scope);
  const inline = useContext(InlineContext);
  const name = node.name;
  const label = resolveText(node.accessibility?.label, ctx);
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  if (isRec(name) && typeof name.svgPath === 'string')
    return (
      <svg viewBox="0 0 24 24" className={inline ? 'size-4' : 'size-5 text-muted-foreground'} fill="currentColor" {...a11y}>
        <path d={name.svgPath} />
      </svg>
    );
  const resolved = toText(resolveValue(name, ctx));
  const Icon = ICONS[resolved];
  if (!Icon) return null;
  return <Icon className={inline ? undefined : 'size-5 shrink-0 text-muted-foreground'} data-icon={inline ? 'inline-start' : undefined} {...a11y} />;
}

function Video({ node, scope }: NodeProps) {
  const url = safeUrl(useText(node.url, scope), 'media');
  if (!url) return null;
  return <video src={url} controls preload="metadata" className="max-h-80 w-full rounded-lg bg-muted" />;
}

function AudioPlayer({ node, scope }: NodeProps) {
  const url = safeUrl(useText(node.url, scope), 'media');
  const description = useText(node.description, scope);
  if (!url) return null;
  return (
    <div className="flex flex-col gap-1">
      {description && <span className="text-xs text-muted-foreground">{description}</span>}
      <audio src={url} controls preload="metadata" className="w-full" />
    </div>
  );
}

// ------------------------------------------------------------------ input

/** The text of a Button: its child Text (or its accessibility label). */
export function buttonLabel(node: A2UIComponent | undefined, components: Record<string, A2UIComponent>, ctx: { model: unknown; scope: string }, depth = 0): string {
  if (!node || depth > 4) return '';
  const a11y = resolveText(node.accessibility?.label, ctx);
  if (a11y) return a11y;
  if (node.component === 'Text') return resolveText(node.text, ctx).replace(/[*_`~]/g, '');
  if (node.component === 'Icon') return toText(resolveValue(node.name, ctx));
  if (typeof node.child === 'string') return buttonLabel(components[node.child], components, ctx, depth + 1);
  if (Array.isArray(node.children))
    return node.children
      .map((id) => (typeof id === 'string' ? buttonLabel(components[id], components, ctx, depth + 1) : ''))
      .filter(Boolean)
      .join(' ');
  return '';
}

/** The failing checks' messages (a check's condition is a DynamicBoolean). */
function failedChecks(checks: unknown, ctx: { model: unknown; scope: string }): string[] {
  if (!Array.isArray(checks)) return [];
  const out: string[] = [];
  for (const rule of checks) {
    if (!isRec(rule)) continue;
    // the protocol doc's flat form {call, args, message} is accepted too
    const cond = rule.condition ?? (isFunctionCall(rule) ? { call: rule.call, args: rule.args } : undefined);
    if (cond === undefined) continue;
    const ok = isFunctionCall(cond) ? evaluateCall(cond, ctx) : resolveValue(cond, ctx);
    if (ok === false && typeof rule.message === 'string') out.push(rule.message);
  }
  return out;
}

const BUTTON_VARIANT = { primary: 'default', default: 'outline', borderless: 'ghost' } as const;

function ButtonNode({ node, scope, trail }: NodeProps) {
  const rt = useRuntime();
  const ctx = useEval(scope);
  const openModal = useContext(TriggerContext);
  const failed = failedChecks(node.checks, ctx);
  const variant = BUTTON_VARIANT[String(node.variant) as keyof typeof BUTTON_VARIANT] ?? 'outline';
  const key = `${node.id}@${scope}`;
  const pressed = rt.pressedKey === key;
  const label = buttonLabel(node, rt.surface.components, ctx);
  const child = typeof node.child === 'string' ? rt.surface.components[node.child] : undefined;
  const iconOnly = child?.component === 'Icon';
  return (
    <Button
      variant={variant}
      size={iconOnly ? 'icon' : 'default'}
      aria-label={iconOnly ? label || undefined : undefined}
      isDisabled={!openModal && (failed.length > 0 || rt.locked || rt.streaming)}
      data-pressed={pressed || undefined}
      onPress={() => (openModal ? openModal() : rt.dispatch(node, scope, label))}
      className="max-w-full"
    >
      <InlineContext.Provider value>{typeof node.child === 'string' && <rt.Node id={node.child} scope={scope} trail={trail} />}</InlineContext.Provider>
      {pressed && <Check data-icon="inline-end" aria-label="Sent" />}
    </Button>
  );
}

function useFieldErrors(node: A2UIComponent, scope: string, touched: boolean, extra: string[] = []): string[] {
  const ctx = useEval(scope);
  if (!touched) return [];
  return [...extra, ...failedChecks(node.checks, ctx)];
}

const asString = (x: unknown) => toText(x);

function TextField({ node, scope }: NodeProps) {
  const id = useId();
  const label = useText(node.label, scope);
  const [value, setValue] = useBound<string>(node.value, scope, '', asString);
  const [touched, setTouched] = useState(false);
  const variant = String(node.variant ?? 'shortText');
  let regexError: string[] = [];
  if (touched && typeof node.validationRegexp === 'string' && value) {
    try {
      if (!new RegExp(node.validationRegexp).test(value)) regexError = ['Invalid format'];
    } catch {
      /* a bad pattern checks nothing */
    }
  }
  const errors = useFieldErrors(node, scope, touched, regexError);
  const onChange = (e: { target: { value: string } }) => {
    setTouched(true);
    setValue(variant === 'number' && e.target.value !== '' && !Number.isNaN(Number(e.target.value)) ? (Number(e.target.value) as unknown as string) : e.target.value);
  };
  return (
    <Field data-invalid={errors.length ? true : undefined}>
      {label && <FieldLabel htmlFor={id}>{label}</FieldLabel>}
      {variant === 'longText' ? (
        <Textarea id={id} value={value} onChange={onChange} aria-invalid={errors.length > 0 || undefined} rows={3} />
      ) : (
        <Input
          id={id}
          type={variant === 'number' ? 'number' : variant === 'obscured' ? 'password' : 'text'}
          value={value}
          onChange={onChange}
          aria-invalid={errors.length > 0 || undefined}
          aria-label={label ? undefined : 'Text field'}
        />
      )}
      {errors.length > 0 && <FieldError>{errors[0]}</FieldError>}
    </Field>
  );
}

function CheckBox({ node, scope }: NodeProps) {
  const id = useId();
  const label = useText(node.label, scope);
  const [value, setValue] = useBound<boolean>(node.value, scope, false, (x) => x === true || x === 'true');
  const [touched, setTouched] = useState(false);
  const errors = useFieldErrors(node, scope, touched);
  return (
    <Field orientation="horizontal" data-invalid={errors.length ? true : undefined}>
      <Checkbox
        id={id}
        isSelected={value}
        isInvalid={errors.length > 0}
        onChange={(v) => {
          setTouched(true);
          setValue(v);
        }}
      />
      <FieldLabel htmlFor={id}>
        <span>
          <InlineMarkdown text={label} />
        </span>
      </FieldLabel>
      {errors.length > 0 && <FieldError>{errors[0]}</FieldError>}
    </Field>
  );
}

const asList = (x: unknown): string[] => (Array.isArray(x) ? x.map(toText) : x === undefined || x === null || x === '' ? [] : [toText(x)]);

function ChoicePicker({ node, scope }: NodeProps) {
  const ctx = useEval(scope);
  const label = useText(node.label, scope);
  const [value, setValue] = useBound<string[]>(node.value, scope, [], asList);
  const [filter, setFilter] = useState('');
  const multiple = node.variant === 'multipleSelection';
  const options = useMemo(
    () =>
      (Array.isArray(node.options) ? node.options : [])
        .filter(isRec)
        .map((o) => ({ value: toText(o.value), label: resolveText(o.label, ctx) || toText(o.value) }))
        .filter((o) => o.value !== ''),
    [node.options, ctx],
  );
  const shown = filter ? options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase())) : options;
  const filterField = node.filterable === true && (
    <Input aria-label={`Filter ${label || 'options'}`} placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
  );
  if (node.displayStyle === 'chips')
    return (
      <FieldSet>
        {label && <FieldLegend variant="label">{label}</FieldLegend>}
        {filterField}
        <ChipGroup
          aria-label={label || 'Options'}
          selectionMode={multiple ? 'multiple' : 'single'}
          selectedKeys={new Set(value)}
          onSelectionChange={(keys) => setValue(keys === 'all' ? options.map((o) => o.value) : [...keys].map(String))}
        >
          <ChipList>
            {shown.map((o) => (
              <Chip key={o.value} id={o.value} textValue={o.label} variant="outline">
                {o.label}
              </Chip>
            ))}
          </ChipList>
        </ChipGroup>
      </FieldSet>
    );
  if (!multiple)
    return (
      <FieldSet>
        {label && <FieldLegend variant="label">{label}</FieldLegend>}
        {filterField}
        <RadioGroup aria-label={label || 'Options'} value={value[0] ?? null} onChange={(v) => setValue([v])} className="gap-2">
          {shown.map((o) => (
            <RadioGroupItem key={o.value} value={o.value}>
              <span className="text-sm">{o.label}</span>
            </RadioGroupItem>
          ))}
        </RadioGroup>
      </FieldSet>
    );
  return (
    <FieldSet>
      {label && <FieldLegend variant="label">{label}</FieldLegend>}
      {filterField}
      <div className="flex flex-col gap-2">
        {shown.map((o) => (
          <MultiOption key={o.value} label={o.label} checked={value.includes(o.value)} onChange={(on) => setValue(on ? [...value, o.value] : value.filter((v) => v !== o.value))} />
        ))}
      </div>
    </FieldSet>
  );
}

function MultiOption({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <Checkbox id={id} isSelected={checked} onChange={onChange} />
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
    </Field>
  );
}

function SliderNode({ node, scope }: NodeProps) {
  const label = useText(node.label, scope);
  const min = typeof node.min === 'number' ? node.min : 0;
  const max = typeof node.max === 'number' && node.max > min ? node.max : min + 100;
  const [value, setValue] = useBound<number>(node.value, scope, min, (x) => (typeof x === 'number' ? x : Number(x) || min));
  const span = max - min;
  const step = span <= 1 ? span / 100 : span <= 20 && !Number.isInteger(value) ? 0.1 : 1;
  const shown = Number.isInteger(step) ? String(Math.round(value)) : value.toFixed(step < 0.1 ? 2 : 1);
  return (
    <Field>
      <div className="flex items-baseline justify-between gap-3">
        <FieldTitle>{label || 'Value'}</FieldTitle>
        <FieldDescription className="font-mono tabular-nums">{shown}</FieldDescription>
      </div>
      <Slider aria-label={label || 'Value'} minValue={min} maxValue={max} step={step} value={Math.min(max, Math.max(min, value))} onChange={(v) => setValue(Array.isArray(v) ? v[0] : v)} />
    </Field>
  );
}

function DateTimeInput({ node, scope }: NodeProps) {
  const id = useId();
  const label = useText(node.label, scope);
  const [value, setValue] = useBound<string>(node.value, scope, '', asString);
  const date = node.enableDate !== false || node.enableTime !== true;
  const time = node.enableTime === true;
  const type = date && time ? 'datetime-local' : time ? 'time' : 'date';
  const toInput = (v: string) => (type === 'date' ? v.slice(0, 10) : type === 'datetime-local' ? v.slice(0, 16) : v.includes('T') ? v.slice(11, 16) : v.slice(0, 5));
  const min = typeof node.min === 'string' ? toInput(node.min) : undefined;
  const max = typeof node.max === 'string' ? toInput(node.max) : undefined;
  return (
    <Field>
      {label && <FieldLabel htmlFor={id}>{label}</FieldLabel>}
      <Input id={id} type={type} value={toInput(value)} min={min} max={max} onChange={(e) => setValue(e.target.value)} aria-label={label ? undefined : 'Date'} />
    </Field>
  );
}

/** The basic catalog's React components, by type name. */
export const BASIC_COMPONENTS = {
  Text,
  Image: ImageNode,
  Icon: IconNode,
  Video,
  AudioPlayer,
  Row,
  Column,
  List,
  Card: CardNode,
  Tabs: TabsNode,
  Modal,
  Divider,
  Button: ButtonNode,
  TextField,
  CheckBox,
  ChoicePicker,
  Slider: SliderNode,
  DateTimeInput,
};
