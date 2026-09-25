import { locate, type Layout, type Zone } from './layout';

const ZONE_LABEL: Record<Zone, string> = { left: 'Left column', right: 'Right column', bottom: 'Bottom column' };

/**
 * Where a panel is in a layout, in words a person can follow to find it:
 * "Left column · tab 2", "Bottom column", "Right column (folded) · group 2",
 * "Floating", or "Hidden" when it is not in the layout at all. The command
 * palette shows this next to each panel, so looking a panel up also teaches
 * where it lives. Tabs and groups are only named when there is more than one,
 * so the common single-panel case stays short.
 */
export function describeLocation(layout: Layout, id: string): string {
  const p = locate(layout, id);
  if (!p) return 'Hidden';
  const parts: string[] = [];
  let panels: string[];
  if (p.kind === 'dock') {
    const col = layout[p.zone];
    parts.push(ZONE_LABEL[p.zone] + (col.collapsed ? ' (folded)' : ''));
    if (col.stacks.length > 1) parts.push(`group ${p.index + 1}`);
    panels = p.stack.panels;
  } else {
    parts.push('Floating');
    panels = p.win.panels;
  }
  if (panels.length > 1) parts.push(`tab ${panels.indexOf(id) + 1}`);
  return parts.join(' · ');
}
