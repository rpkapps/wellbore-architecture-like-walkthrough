import type { AssistantHost, AutonomyMode, Dataset } from './types';
import { summariseDataset } from './datasets';
import { safeJsonStringify } from './json';

/*
 * The system prompt, and the state block each user message carries. The
 * system prompt holds only what stays the same for the whole conversation
 * (it changes only with the autonomy mode or the connection's tools), so
 * providers that cache prompt prefixes reuse it, and Claude's replayed
 * thinking stays bound to an unchanged prefix. What changes (the app's state,
 * the datasets, the date) is recorded with each user message instead.
 */

export interface SystemPromptInput {
  host: AssistantHost;
  autonomy: AutonomyMode;
  /** tools are offered on this connection */
  tools: boolean;
  /** the A2UI guide (the generated-interface protocol), when `render_ui` is offered */
  a2uiGuide?: string;
}

const AUTONOMY: Record<AutonomyMode, string> = {
  read: 'You can only look: tools that change the app are not available in this mode. When the person asks for a change, explain how to do it in the app (or that they can allow actions in the assistant settings).',
  ask: 'Every tool call that changes the app waits for the person to approve it. Propose the change and call the tool; do not ask for permission in text first. If a call is declined, accept it and do not retry it.',
  auto: 'You may change the app without asking, except for actions marked as needing approval, which wait for the person. Do what was asked, then say briefly what you changed. If a call is declined, accept it and do not retry it.',
};

/** Builds the system prompt for a turn. */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const { host, tools } = input;
  const sections: string[] = [];

  sections.push(
    `You are the assistant built into ${host.appName}. You help the person understand and work with the app and its data${tools ? ', and you can operate the app through tools' : ''}.`,
  );

  if (tools) {
    sections.push(
      [
        '# Using tools',
        '- Look before you act or answer: read the app state and data with tools rather than guessing. Never invent data, values, names or results.',
        '- When several independent reads are needed, call them together.',
        '- A tool result may hand over a dataset: you see its id (ds_1…), columns, size, sample rows and statistics, not every row. Use `query_dataset` to filter, aggregate or derive datasets. Say which dataset a figure comes from.',
        '- If a tool fails, read the error, fix the arguments and try again once or twice; then explain what went wrong.',
        '- Keep going until the request is done, then answer. Do not narrate each call.',
      ].join('\n'),
    );
  }

  if (input.a2uiGuide) sections.push(`# Generated interfaces\n${input.a2uiGuide.trim()}`);

  const links = host.onLink ? '\n- Links of the form `app://…` are actions in the app; only use ones you were told about.' : '';
  sections.push(
    [
      '# Answering',
      '- Write in Markdown. Be concise and direct: lead with the answer, then the essentials. Use lists and tables when they help, not by default.',
      '- Always give units with numbers. Match the precision to the data.',
      '- If something is uncertain or unavailable, say so plainly.',
    ].join('\n') + links,
  );

  const instructions = safe(() => host.instructions())?.trim();
  if (instructions) sections.push(`# About ${host.appName}\n${instructions}`);

  sections.push(`# Autonomy\n${AUTONOMY[input.autonomy]}`);

  return sections.join('\n\n');
}

/**
 * What the model is told about the moment a message was sent: the app's
 * snapshot, the datasets it can bind to or query, and the date.
 */
export function buildTurnState(input: { host: AssistantHost; datasets: Dataset[]; now?: Date }): string {
  const sections: string[] = [];
  const snapshot = input.host.snapshot ? safe(() => input.host.snapshot!()) : undefined;
  if (snapshot !== undefined && snapshot !== null) sections.push(`App state when this message was sent (tool results are newer):\n${safeJsonStringify(snapshot, 6000)}`);
  if (input.datasets.length) {
    const recent = input.datasets.slice(-12);
    const lines = recent.map((d) => {
      const s = summariseDataset(d);
      const cols = s.columns.map((c) => `${c.key}${c.unit ? ` [${c.unit}]` : ''}`).join(', ');
      return `- ${s.id} “${s.title}”${s.source ? ` (${s.source})` : ''}: ${s.rowCount} rows; columns ${cols}`;
    });
    const older = input.datasets.length - recent.length;
    sections.push(`Datasets in this conversation:\n${lines.join('\n')}${older > 0 ? `\n(${older} older datasets not listed; they can still be queried by id)` : ''}`);
  }
  sections.push(`Date: ${(input.now ?? new Date()).toISOString().slice(0, 10)}`);
  return sections.join('\n\n');
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
