import { Button } from '@tecton/react/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tecton/react/components/collapsible';
import { Switch } from '@tecton/react/components/switch';
import { cn } from 'cn';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import { Tip } from './icon-button';

/**
 * Lists of on/off switches in named groups (features, overlays, graphics
 * options). A group header carries a disclosure chevron, the title, how many
 * items are on, and a quiet "All on" / "All off" text action; under it,
 * indented on a hairline guide, rows of one height whose switches line up in
 * one right-hand column. Only rows have switches: a switch on the header read
 * as an odd "parent switch". Heights are in rem, so the density preference
 * (the root font size) scales them with everything else.
 */

/**
 * The quiet text action that sets a whole group: "All on" while anything is
 * off, else "All off" ("Show all" / "Hide all" with `verb="show"`). Its
 * accessible name says exactly what a press does ("Turn on all 6 Geoscience
 * features"). Also for group toggles outside a `SwitchGroup` (the track list).
 */
export function AllToggle({ on, total, what, onAll, verb = 'turn', className }: { on: number; total: number; what: string; onAll: (on: boolean) => void; verb?: 'turn' | 'show'; className?: string }) {
  const next = on < total;
  const count = total === 1 ? 'the' : total === 2 ? 'both' : `all ${total}`;
  const label = verb === 'show' ? `${next ? 'Show' : 'Hide'} ${count} ${what}` : `Turn ${next ? 'on' : 'off'} ${count} ${what}`;
  const text = verb === 'show' ? (next ? 'Show all' : 'Hide all') : next ? 'All on' : 'All off';
  return (
    <Tip label={label}>
      <Button variant="ghost" size="xs" aria-label={label} onPress={() => onAll(next)} className={cn('text-fg-2 hover:text-fg-1', className)}>
        {text}
      </Button>
    </Tip>
  );
}

/** Number of fixed action slots at the end of each row, shared by a group's rows. */
const SlotsContext = createContext(0);

/** Width of one trailing action slot: an `icon-xs` button. */
const SLOT_REM = 1.5;

/**
 * A titled, collapsible group of `SwitchRow`s. The header reads, from the
 * left: disclosure chevron, title, "3 of 6 on", and at the end the group's
 * `AllToggle`, which ends on the rows' switch column. The rows sit indented
 * under the title on a hairline guide, so it is plain what the group holds.
 * `actionSlots` reserves that many trailing button slots in every row, so each
 * kind of action stays in one column whether or not a row has it.
 */
export function SwitchGroup({
  title,
  on,
  total,
  onAll,
  noun = 'items',
  verb = 'turn',
  isExpanded,
  defaultExpanded = true,
  onExpandedChange,
  actionSlots = 0,
  className,
  children,
}: {
  title: string;
  /** items on, of `total` */
  on: number;
  total: number;
  /** set every item of the group */
  onAll: (on: boolean) => void;
  /** plural name of the items, for the action's label ("features", "overlays") */
  noun?: string;
  /** "All on / off" (turn) or "Show / Hide all" (show) */
  verb?: 'turn' | 'show';
  isExpanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  actionSlots?: number;
  className?: string;
  children: ReactNode;
}) {
  const [own, setOwn] = useState(defaultExpanded);
  const expanded = isExpanded ?? own;
  return (
    <Collapsible
      isExpanded={expanded}
      onExpandedChange={(v) => {
        setOwn(v);
        onExpandedChange?.(v);
      }}
      className={cn('border-t border-border-subtle', className)}
    >
      <div className="flex h-8 items-center gap-2 pr-3">
        <CollapsibleTrigger className="group/sg flex h-full min-w-0 flex-1 cursor-default items-center gap-1.5 pl-3 text-fg-3 outline-none hover:text-fg-2 aria-expanded:text-fg-1 data-focus-visible:ring-2 data-focus-visible:ring-ring data-focus-visible:ring-inset">
          <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-fg-3 transition-transform group-aria-expanded/sg:rotate-90" />
          <span className="type-section min-w-0 truncate text-inherit!">{title}</span>
          <span className="type-caption ml-1 shrink-0 whitespace-nowrap">
            <span className="tabular-nums">{on}</span> of <span className="tabular-nums">{total}</span> {verb === 'show' ? 'shown' : 'on'}
          </span>
        </CollapsibleTrigger>
        <AllToggle on={on} total={total} what={`${title} ${noun}`} onAll={onAll} verb={verb} className="-mr-1.5" />
      </div>
      <CollapsibleContent>
        {/* rows are only built while the group is open */}
        {expanded && (
          <SlotsContext.Provider value={actionSlots}>
            <div className="mr-1.5 mb-2 ml-[1.1875rem] flex flex-col gap-px border-l border-border-subtle pl-1">{children}</div>
          </SlotsContext.Provider>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One item of a `SwitchGroup`: icon, name (one line) with its badges, a one-line
 * muted description, trailing actions in fixed slots, and the switch. Every
 * row is the same height; clipped text shows in full on hover. `settings`, when
 * given, adds a chevron in the last slot that unfolds them under the row,
 * inside the group's indent. An off row keeps its text legible and only mutes
 * its icon.
 */
export function SwitchRow({
  icon,
  name,
  badges,
  description,
  actions = [],
  isSelected,
  onChange,
  isDisabled,
  settings,
  settingsLabel,
}: {
  icon?: ReactNode;
  name: string;
  badges?: ReactNode;
  description?: string;
  /** trailing buttons (size icon-xs), one per slot, in order; null leaves a slot empty */
  actions?: ReactNode[];
  isSelected: boolean;
  onChange: (on: boolean) => void;
  isDisabled?: boolean;
  /** the item's settings, built only while unfolded */
  settings?: () => ReactNode;
  settingsLabel?: string;
}) {
  const id = useId();
  const reserved = useContext(SlotsContext);
  const [open, setOpen] = useState(false);
  const slots = [...actions];
  if (settings) {
    // the settings chevron always takes the last slot
    while (slots.length < reserved - 1) slots.push(null);
    slots.push(
      <Tip key="settings" label={open ? 'Hide settings' : 'Settings'}>
        <Button slot="trigger" variant="ghost" size="icon-xs" aria-label={settingsLabel ?? `${name} settings`}>
          <ChevronDownIcon className={cn('transition-transform', open && 'rotate-180')} />
        </Button>
      </Tip>,
    );
  }
  const n = Math.max(reserved, slots.length);
  return (
    <Collapsible isExpanded={open && !!settings} onExpandedChange={setOpen} className="flex flex-col">
      <div className={cn('flex min-w-0 items-center gap-2 rounded-md pr-1.5 pl-1.5 hover:bg-ghost-hover/40', description ? 'h-11' : 'h-8')} data-disabled={isDisabled || undefined}>
        {icon && (
          <span
            aria-hidden
            className={cn('flex size-5 shrink-0 items-center justify-center rounded-sm transition-colors [&_svg]:size-3.5', isSelected ? 'bg-ui-accent/15 text-ui-accent' : 'bg-muted text-fg-3')}
          >
            {icon}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="flex min-w-0 items-center gap-1.5">
            <label htmlFor={id} title={name} className="min-w-0 truncate text-[0.857rem] leading-5 font-medium text-fg-1 in-data-disabled:opacity-50">
              {name}
            </label>
            {badges && <span className="flex shrink-0 items-center gap-1">{badges}</span>}
          </div>
          {description && (
            <p className="type-caption truncate" title={description}>
              {description}
            </p>
          )}
        </div>
        {n > 0 && (
          <div className="flex shrink-0 items-center justify-end" style={{ width: `${n * SLOT_REM}rem` }}>
            {Array.from({ length: n }, (_, i) => (
              <span key={i} className="flex size-6 items-center justify-center">
                {slots[i] ?? null}
              </span>
            ))}
          </div>
        )}
        <Switch id={id} isSelected={isSelected} onChange={onChange} isDisabled={isDisabled} />
      </div>
      {settings && (
        <CollapsibleContent>
          {/* aligned with the name, under the row */}
          {open && <div className={cn('flex flex-col gap-1.5 pt-1 pr-1.5 pb-2.5', icon ? 'pl-[2.125rem]' : 'pl-1.5')}>{settings()}</div>}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
