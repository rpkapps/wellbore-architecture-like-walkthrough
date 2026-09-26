import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssistantPanel } from '../../src/assistant/ui';
import { createFakeController } from '../../src/assistant/ui/dev/fakeController';
import { argsSummary, formatDuration, humaniseToolName, relativeTime } from '../../src/assistant/ui/format';

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

  it('renders the empty state and the onboarding', () => {
    const empty = renderToStaticMarkup(createElement(AssistantPanel, { controller: createFakeController({ scenario: 'empty' }) }));
    expect(empty).toContain('Ask BoreWalk anything');
    expect(empty).toContain('Summarise this well');
    const onboarding = renderToStaticMarkup(createElement(AssistantPanel, { controller: createFakeController({ scenario: 'onboarding' }) }));
    expect(onboarding).toContain('Connect a model');
    expect(onboarding).toContain('Anthropic');
  });
});
