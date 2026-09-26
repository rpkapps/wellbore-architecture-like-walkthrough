import { locate, type Layout, type Zone } from './layout';

const ZONE_LABEL: Record<Zone, string> = { left: 'Left sidebar', right: 'Right sidebar', bottom: 'Bottom panel' };

/**
 * Where a panel is in a layout, in words a person can follow to find it:
 * "Left sidebar · top · tab 2", "Left sidebar · bottom", "Right sidebar
 * (folded)", "Bottom panel", "Floating", or "Hidden" when it is not in the
 * layout at all. The command palette shows this next to each panel, so
 * looking a panel up also teaches where it lives. A sidebar's slots are only
 * named when it is split, and tabs only when there is more than one, so the
 * common case stays short.
 */
export function describeLocation(layout: Layout, id: string): string {
  const p = locate(layout, id);
  if (!p) return 'Hidden';
  const parts: string[] = [];
  let panels: string[];
  if (p.kind === 'dock') {
    const col = layout[p.zone];
    parts.push(ZONE_LABEL[p.zone] + (col.collapsed ? ' (folded)' : ''));
    if (col.stacks.length > 1) parts.push(p.index === 0 ? 'top' : 'bottom');
    panels = p.stack.panels;
  } else {
    parts.push('Floating');
    panels = p.win.panels;
  }
  if (panels.length > 1) parts.push(`tab ${panels.indexOf(id) + 1}`);
  return parts.join(' · ');
}
