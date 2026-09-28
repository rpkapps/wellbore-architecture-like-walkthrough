import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssistantPanel } from '../../src/assistant/ui';
import { createFakeController } from '../../src/assistant/ui/dev/fakeController';
import { argsSummary, formatDuration, humaniseToolName, relativeTime } from '../../src/assistant/ui/format';
import { compactionTokens } from '../../src/assistant/ui/parts/Compaction';

describe('ui: format helpers', () => {
  it('humanises tool names and summarises arguments', () => {
    expect(humaniseToolName('view.color_by')).toBe('View · color by');
    expect(argsSummary({ well: 'F-11 A', from_md: 3000, curves: ['GR', 'RHOB'] })).toBe('well: F-11 A, from md: 3000, curves: [GR, RHOB]');
    expect(formatDuration(420)).toBe('420 ms');
    expect(formatDuration(1320)).toBe('1.3 s');
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe('5 min ago');
  });
});

describe('ui: AssistantPanel', () => {
  it('renders a conversation with every part type', () => {
    const controller = createFakeController({ scenario: 'error' });
    const out = renderToStaticMarkup(createElement(AssistantPanel, { controller, onClose: () => undefined }));
    expect(out).toContain('data-slot="assistant-panel"');
    expect(out).toContain('data-slot="assistant-user-message"');
    expect(out).toContain('data-slot="assistant-reply"');
    expect(out).toContain('data-slot="assistant-reasoning"');
    expect(out).toContain('data-slot="assistant-tool-group"');
    expect(out).toContain('data-slot="assistant-error"');
    expect(out).toContain('You pressed “Show in 3D”');
    // render_ui calls are hidden: their surface shows instead
    expect(out).not.toContain('Render ui');
    expect(out).toContain('aria-label="Close assistant"');
  });

  it('renders the approval card for a waiting call', () => {
    const out = renderToStaticMarkup(createElement(AssistantPanel, { controller: createFakeController({ scenario: 'approval' }) }));
    expect(out).toContain('data-slot="assistant-approval"');
    expect(out).toContain('Allow “Delete formation top”?');
  });

  it('groups the waiting calls of one step in one card, each described in words', () => {
    const out = renderToStaticMarkup(createElement(AssistantPanel, { controller: createFakeController({ scenario: 'approvals' }) }));
    expect(out.match(/data-slot="assistant-approval-group"/g)?.length).toBe(1);
    expect(out).not.toContain('data-slot="assistant-approval"');
    expect(out).toContain('Allow 3 changes?');
    expect(out.match(/data-slot="assistant-approval-row"/g)?.length).toBe(3);
    // the tool's own phrase, not its title and raw arguments
    expect(out).toContain('Hide Log curtain');
    expect(out).toContain('aria-label="Approve: Hide Oil–water contact"');
    expect(out).toContain('aria-label="Deny: Hide Uncertainty cone"');
    expect(out).not.toContain('Allow “Overlay”');
    for (const label of ['Approve all', 'Deny all', 'Always allow these in this chat']) expect(out).toContain(label);
    // the last turn holds the viewport's height; nothing is marked as a scroll anchor
    expect(out).toContain('data-slot="assistant-turn"');
    expect(out).not.toContain('data-scroll-anchor="true"');
  });

  it('renders the empty state and the onboarding', () => {
    const empty = renderToStaticMarkup(createElement(AssistantPanel, { controller: createFakeController({ scenario: 'empty' }) }));
    expect(empty).toContain('Ask BoreWalk anything');
    expect(empty).toContain('Summarise this well');
    const onboarding = renderToStaticMarkup(createElement(AssistantPanel, { controller: createFakeController({ scenario: 'onboarding' }) }));
    expect(onboarding).toContain('Connect a model');
    expect(onboarding).toContain('Anthropic');
  });

  it('marks where a summary took over, and shows the context meter past half the window', () => {
    const controller = createFakeController({ scenario: 'compacted' });
    const out = renderToStaticMarkup(createElement(AssistantPanel, { controller }));
    expect(out).toContain('data-slot="assistant-compaction"');
    expect(out).toContain('Earlier messages summarised to save space');
    // the messages above it stay, muted
    expect(out.match(/data-slot="assistant-user-message"/g)?.length).toBe(3);
    expect(out).toContain('opacity-70');
    expect(out).toContain('data-slot="assistant-context-meter"');
    expect(out).toContain('aria-label="Context 78% used. Context options"');
    expect(compactionTokens({ tokensBefore: 48_210, tokensAfter: 2_980 })).toBe('≈ 48k → 3k tokens');
    expect(compactionTokens({ tokensBefore: 48_210 })).toBe('');
  });

  it('hides the meter below half the window and says when it is compacting', () => {
    const controller = createFakeController({ scenario: 'conversation', speed: 0 });
    const quiet = renderToStaticMarkup(createElement(AssistantPanel, { controller }));
    expect(quiet).not.toContain('assistant-context-meter');
    expect(quiet).not.toContain('assistant-compaction');
    controller.compact();
    expect(controller.getSnapshot().context?.compacting).toBe(true);
    const busy = renderToStaticMarkup(createElement(AssistantPanel, { controller }));
    expect(busy).toContain('data-slot="assistant-compacting"');
    expect(busy).toContain('Compacting the conversation…');
    // below half the window the meter stays hidden: the transcript says it all
    expect(busy).not.toContain('assistant-context-meter');
  });
});
