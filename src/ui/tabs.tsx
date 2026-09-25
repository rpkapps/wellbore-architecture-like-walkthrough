import { TabsList, TabsTrigger } from '@tecton/react/components/tabs';
import type { ComponentProps } from 'react';

/**
 * Tab strips the size of a small ghost button (Tecton's tab list is sized for
 * page headers): no container fill, and the selected tab takes the ghost
 * "active" surface, like a pressed toolbar button.
 */
export function TabStrip({ className, ...props }: ComponentProps<typeof TabsList>) {
  return <TabsList {...props} className={`h-auto! gap-0.5 rounded-none! bg-transparent! p-0! ${className ?? ''}`} />;
}

export function Tab({ className, ...props }: ComponentProps<typeof TabsTrigger>) {
  return (
    <TabsTrigger
      {...props}
      className={`h-7! flex-none! gap-1.5 rounded-[min(var(--radius-md),10px)]! border-0! px-2! text-xs! font-medium! text-fg-2! hover:bg-ghost-hover! hover:text-fg-1! data-selected:bg-ghost-active! data-selected:text-fg-1! [&_svg:not([class*='size-'])]:size-3.5 ${className ?? ''}`}
    />
  );
}
