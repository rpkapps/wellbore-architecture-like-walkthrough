import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@tecton/react/components/accordion';
import type { ComponentProps, ReactNode } from 'react';

/**
 * Collapsible sections of a panel: small uppercase headers that brighten when
 * open (instead of Tecton's filled "active" block), hairline dividers and
 * tight content padding.
 */
export function PanelAccordion({ className, ...props }: ComponentProps<typeof Accordion>) {
  return <Accordion allowsMultipleExpanded {...props} className={`rounded-none! border-t border-border-subtle ${className ?? ''}`} />;
}

export function PanelSection({ id, title, aside, control, children }: { id: string; title: ReactNode; aside?: ReactNode; control?: ReactNode; children: ReactNode }) {
  return (
    <AccordionItem id={id} className="relative not-last:border-border-subtle!">
      {/* a control for the whole section (a switch for all its items) sits on the header, outside its button */}
      {control && <div className="absolute top-0 right-8 z-10 flex h-8 items-center">{control}</div>}
      <AccordionTrigger className="h-8! items-center! px-3! py-0! text-[0.75rem]! font-semibold! tracking-[0.07em] text-fg-3! uppercase hover:bg-ghost-hover/50! aria-expanded:bg-transparent! aria-expanded:text-fg-1! **:data-[slot=accordion-trigger-icon]:size-3.5! **:data-[slot=accordion-trigger-icon]:text-fg-3!">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {title}
          {aside}
        </span>
      </AccordionTrigger>
      <AccordionContent className="px-3! pt-0.5! pb-3! text-fg-2!">{children}</AccordionContent>
    </AccordionItem>
  );
}
