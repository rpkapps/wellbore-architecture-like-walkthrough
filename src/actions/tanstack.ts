import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';
import type { ActionRegistry } from './registry';

/**
 * The app's actions as TanStack AI client tools: pass the result to
 * `useChat({ connection, tools })` (from `@tanstack/ai-react`, added with the
 * chat). A tool call from the model runs here in the browser, through the
 * same registry as the command palette, so it validates its input the same
 * way and shows up in the same run history. Actions marked `needsApproval`
 * pause the model until the person approves them in the chat.
 *
 * Nothing imports this module yet: it is the seam the assistant plugs into.
 */
export function clientTools<Ctx>(registry: ActionRegistry<Ctx>) {
  return registry.list().map((a) =>
    toolDefinition({
      name: a.id,
      description: `${a.title}. ${a.description}`,
      inputSchema: a.input ?? z.object({}),
      needsApproval: !!a.needsApproval,
    }).client(async (args: unknown) => {
      const r = await registry.run(a.id, a.input ? args : undefined);
      // an error goes back to the model as the tool's result, so it can correct itself
      return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
    }),
  );
}
