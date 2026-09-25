import { Field, FieldLabel, FieldLegend, FieldSet, FieldTitle } from '@tecton/react/components/field';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@tecton/react/components/select';
import { Slider } from '@tecton/react/components/slider';
import { Switch } from '@tecton/react/components/switch';
import { useId, type ReactNode } from 'react';
import type { Key } from 'react-aria-components';

/**
 * Form rows shared by the side panels and the feature settings: Tecton
 * controls with their labels, sized for dense tool panels.
 */

/** A titled group of controls in a tool panel. `aside` sits at the end of the title row. */
export function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <FieldSet className="min-w-0 gap-3">
      <FieldLegend variant="label" className="mb-0 flex w-full items-center justify-between gap-2">
        <span>{title}</span>
        {aside}
      </FieldLegend>
      {children}
    </FieldSet>
  );
}

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
  return (
    <Field className="gap-1" data-disabled={isDisabled || undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <FieldTitle>{label}</FieldTitle>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{format(value)}</span>
      </div>
      {/* the thumb overhangs the track ends by half its width */}
      <div className="px-2.5">
        <Slider aria-label={label} value={value} minValue={minValue} maxValue={maxValue} step={step} isDisabled={isDisabled} onChange={(v) => onChange(Array.isArray(v) ? v[0] : v)} />
      </div>
    </Field>
  );
}

export function SwitchField({ label, isSelected, onChange, aside, isDisabled }: { label: ReactNode; isSelected: boolean; onChange: (on: boolean) => void; aside?: ReactNode; isDisabled?: boolean }) {
  const id = useId();
  return (
    <Field orientation="horizontal" className="gap-2" data-disabled={isDisabled || undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {aside}
      </FieldLabel>
      <Switch id={id} size="sm" isSelected={isSelected} onChange={onChange} isDisabled={isDisabled} />
    </Field>
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

/** A labelled select. `options` may be grouped; `placeholder` allows no selection. */
export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  orientation = 'horizontal',
  hideLabel,
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
    <Field orientation={orientation} className="gap-2">
      <FieldLabel htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>
        {label}
      </FieldLabel>
      <CompactSelect id={id} label={label} value={value} onChange={onChange} options={options} placeholder={placeholder} />
    </Field>
  );
}

/** Select without a visible label, for panel headers and toolbars; named by `label`. */
export function CompactSelect({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
  size = 'sm',
  className,
}: {
  id?: string;
  label: string;
  value: string | null;
  onChange: (v: string) => void;
  options: (Option | OptionGroup)[];
  placeholder?: string;
  size?: 'sm' | 'default';
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
      <SelectTrigger id={id} size={size} className="min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="min-w-48">
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
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>;
}
