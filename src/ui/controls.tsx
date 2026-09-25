import { FieldLegend, FieldSet } from '@tecton/react/components/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@tecton/react/components/select';
import { Switch } from '@tecton/react/components/switch';
import { useId, type ReactNode } from 'react';
import type { Key } from 'react-aria-components';
import { ScrubField } from './scrub';

/**
 * Form rows shared by the panels and the feature settings. Every row is one
 * 24 px line: a scrub bar for numbers, a label with a ghost select, a label
 * with a switch.
 */

/** A titled group of controls in a tool panel. `aside` sits at the end of the title row. */
export function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <FieldSet className="min-w-0 gap-1.5">
      <FieldLegend className="type-section mb-0! flex w-full items-center justify-between gap-2">
        <span>{title}</span>
        {aside}
      </FieldLegend>
      {children}
    </FieldSet>
  );
}

/** A number in a range, as a scrub bar (drag, click to type, arrow keys). */
export function SliderField({
  label,
  value,
  onChange,
  minValue,
  maxValue,
  step,
  format = (v) => String(v),
  isDisabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  minValue: number;
  maxValue: number;
  step: number;
  format?: (v: number) => string;
  isDisabled?: boolean;
}) {
  return <ScrubField label={label} value={value} onChange={onChange} min={minValue} max={maxValue} step={step} format={format} isDisabled={isDisabled} />;
}

export function SwitchField({ label, isSelected, onChange, aside, isDisabled }: { label: ReactNode; isSelected: boolean; onChange: (on: boolean) => void; aside?: ReactNode; isDisabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex h-7 min-w-0 items-center gap-2" data-disabled={isDisabled || undefined}>
      <label htmlFor={id} className="type-label flex min-w-0 flex-1 items-center gap-1.5 truncate data-disabled:opacity-50">
        {label}
        {aside}
      </label>
      <Switch id={id} isSelected={isSelected} onChange={onChange} isDisabled={isDisabled} />
    </div>
  );
}

export interface Option {
  id: string;
  label: string;
  isDisabled?: boolean;
}

export interface OptionGroup {
  label: string;
  options: Option[];
}

/** A labelled select on one row: the label, then the value as a ghost select. */
export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string | null;
  onChange: (v: string) => void;
  options: (Option | OptionGroup)[];
  placeholder?: string;
  orientation?: 'horizontal' | 'vertical';
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex h-7 min-w-0 items-center gap-2">
      <label htmlFor={id} className="type-label min-w-0 flex-1 truncate">
        {label}
      </label>
      <CompactSelect id={id} label={label} value={value} onChange={onChange} options={options} placeholder={placeholder} className="max-w-[60%] min-w-0 shrink" />
    </div>
  );
}

/** Ghost select trigger: text and a chevron that only takes a surface on hover. */
const GHOST = 'border-transparent! bg-transparent! shadow-none! hover:bg-ghost-hover! data-pressed:bg-ghost-active! aria-expanded:bg-ghost-active! pl-2! pr-1! gap-1! text-fg-1 [&_svg]:text-fg-3';

/** Select without a visible label, for panel headers and toolbars; named by `label`. */
export function CompactSelect({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
  size = 'sm',
  appearance = 'ghost',
  className,
}: {
  id?: string;
  label: string;
  value: string | null;
  onChange: (v: string) => void;
  options: (Option | OptionGroup)[];
  placeholder?: string;
  size?: 'sm' | 'default';
  appearance?: 'ghost' | 'field';
  className?: string;
}) {
  return (
    <Select
      aria-label={label}
      placeholder={placeholder}
      selectedKey={value || null}
      onSelectionChange={(k: Key | null) => {
        if (k !== null) onChange(String(k));
      }}
      className={className ?? 'min-w-0 shrink'}
    >
      <SelectTrigger id={id} size={size} className={`min-w-0 ${appearance === 'ghost' ? GHOST : ''}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="w-max max-w-[min(32rem,90vw)] min-w-(--trigger-width)">
        {options.map((o) =>
          'options' in o ? (
            <SelectGroup key={o.label}>
              <SelectLabel>{o.label}</SelectLabel>
              {o.options.map((x) => (
                <SelectItem key={x.id} id={x.id} textValue={x.label} isDisabled={x.isDisabled}>
                  {x.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : (
            <SelectItem key={o.id} id={o.id} textValue={o.label} isDisabled={o.isDisabled}>
              {o.label}
            </SelectItem>
          ),
        )}
      </SelectContent>
    </Select>
  );
}

/** Short note under a setting, for units, provenance and caveats. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="type-caption">{children}</p>;
}
