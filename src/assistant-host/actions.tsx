import { SparklesIcon } from 'lucide-react';
import { z } from 'zod';
import { defineAction, type Action, type AnyAction } from '../actions/registry';
import type { App } from '../ui/app';
import { SELECTION_KINDS, SelectionSchema } from '../ui/selection';
import { assistantShown, closeAssistant, loadAssistant, openAssistant } from './lazy';

/*
 * The assistant's own actions: the palette, ⌘I and the right-click menus run
 * these. They stay out of the assistant's tool list (`tools.ts`). Sending a
 * question loads the assistant's chunk first.
 */

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** The shortcut that toggles the panel, as the palette and the top bar show it. */
export const ASSISTANT_SHORTCUT = isMac ? '⌘I' : 'Ctrl I';

/** Opens the panel and sends a question, with the current context (the selection) attached. */
async function ask(app: App, prompt: string) {
  openAssistant(app);
  const { ensureAssistant } = await loadAssistant();
  const c = ensureAssistant(app);
  c.send({ text: prompt, context: c.host.context?.() });
}

export function assistantActions(): AnyAction<App>[] {
  const A = <S extends z.ZodType = z.ZodUndefined>(a: Action<S, App>) => defineAction<App, S>(a);
  return [
    A({
      id: 'assistant.toggle',
      title: 'Assistant',
      description: 'Opens the AI assistant beside the 3D view (to ask about the data, chart it, or have the app operated for you), or closes it.',
      category: 'Panels',
      where: 'Top bar › Assistant',
      shortcut: ASSISTANT_SHORTCUT,
      icon: <SparklesIcon />,
      keywords: ['ai', 'chat', 'ask', 'copilot', 'help', 'question'],
      run: (app) => {
        if (assistantShown(app)) closeAssistant(app);
        else openAssistant(app);
        return { open: assistantShown(app) };
      },
    }),
    A({
      id: 'assistant.ask',
      title: 'Ask the assistant',
      description: 'Sends a question to the AI assistant, with the selected object attached, and opens its panel.',
      category: 'Panels',
      icon: <SparklesIcon />,
      keywords: ['ai', 'chat', 'question', 'explain', 'chart', 'plot'],
      input: z.object({ prompt: z.string().min(1).max(4000) }),
      prompt: { label: 'Ask the assistant', placeholder: 'e.g. Where is the best pay in this well?', parse: (t) => (t.trim() ? { prompt: t.trim() } : null) },
      run: (app, { prompt }) => ask(app, prompt),
    }),
    A({
      id: 'assistant.ask_about',
      title: 'Ask the assistant about this',
      description: 'Opens the AI assistant with the selected object attached to the next message, ready for a question about it (or sends one).',
      category: 'Panels',
      icon: <SparklesIcon />,
      keywords: ['ai', 'chat', 'explain', 'what is this'],
      input: z.object({ selection: SelectionSchema.optional(), prompt: z.string().max(4000).optional() }).optional(),
      appliesTo: [...SELECTION_KINDS],
      onSelection: (sel) => ({ input: { selection: sel }, label: 'Ask the assistant' }),
      run: async (app, input) => {
        if (input?.selection) app.select(input.selection);
        if (input?.prompt?.trim()) await ask(app, input.prompt.trim());
        else openAssistant(app);
      },
    }),
  ];
}
