import { Button } from '@tecton/react/components/button';
import { Popover, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@tecton/react/components/popover';
import { Link2Icon, PinIcon } from 'lucide-react';
import { SwitchField } from '../controls';
import type { LinkState } from '../toolWindow';

/** A well's name without the field prefix, for a chip ("15/9-F-11 B" → "F-11 B"). */
export const shortWell = (name: string) => name.replace(/^15\/9-/, '');

/** The chip's text: what the view shows, then what it follows ("F-11 B · depth cursor"). */
export function linkLabel(s: LinkState): string {
  const on = s.channels.filter((c) => c.on && !c.disabled).map((c) => c.short);
  return [shortWell(s.subject), ...(s.pinned ? ['pinned'] : []), ...on].join(' · ');
}

/**
 * What a view follows, stated in its header ("⛓ F-11 B · depth cursor"), as
 * ParaView and Spotfire show linked views. Pressing it opens the switches for
 * the channels that view supports, and "Pin to this well" where the view can
 * stay on one well while another is opened (two views can then compare wells).
 */
export function LinkChip({ state }: { state: LinkState }) {
  const pinned = !!state.pinned;
  return (
    <PopoverTrigger>
      <Button variant="ghost" size="xs" aria-label={`Linked: ${linkLabel(state)}. Change what this view follows`} className="max-w-56 min-w-0 text-muted-foreground">
        {pinned ? <PinIcon data-icon="inline-start" /> : <Link2Icon data-icon="inline-start" />}
        <span className="truncate">{linkLabel(state)}</span>
      </Button>
      <Popover placement="bottom start" className="w-80">
        <PopoverHeader>
          <PopoverTitle>Linked to</PopoverTitle>
          <PopoverDescription>
            {state.pin
              ? pinned
                ? `Stays on ${state.pinned} whichever well is open.`
                : `Shows the open well, now ${state.subject}.`
              : state.followsWell
                ? `Shows the open well, now ${state.subject}.`
                : `Shows ${state.subject}.`}
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col">
          {state.pin && <SwitchField label="Pin to this well" isSelected={pinned} onChange={(v) => state.pin!(v)} />}
          {state.channels.map((c) => (
            <SwitchField key={c.id} label={c.disabled ? `${c.label} (${c.disabled})` : c.label} isSelected={c.on && !c.disabled} isDisabled={!c.set || !!c.disabled} onChange={(v) => c.set?.(v)} />
          ))}
          {state.channels.some((c) => !c.set) && <p className="type-caption pt-1">Dimmed links are how this view always works.</p>}
        </div>
      </Popover>
    </PopoverTrigger>
  );
}
