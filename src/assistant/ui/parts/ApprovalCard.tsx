import { memo, useId } from 'react';
import { CheckIcon, ShieldAlertIcon, XIcon } from 'lucide-react';
import { Button } from '@tecton/react/components/button';
import type { ToolCallPart } from '../../core/types';
import { usePanel } from '../context';
import { prettyJson } from '../format';

function argEntries(args: unknown): [string, string][] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args === undefined ? [] : [['value', prettyJson(args)]];
  return Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .slice(0, 8)
    .map(([k, v]) => [k.replace(/_/g, ' '), typeof v === 'string' ? v : JSON.stringify(v)]);
}

/**
 * A tool call waiting for the person: what it will do (title and
 * arguments) and Approve / Deny / always allow. Rendered in place of the
 * call's activity row; the first one of a reply takes focus-visible order
 * right after the reply's text.
 */
export const ApprovalCard = memo(function ApprovalCard({ call }: { call: ToolCallPart }) {
  const { controller, toolTitle } = usePanel();
  const titleId = useId();
  const title = toolTitle(call.name);
  const entries = argEntries(call.args);
  return (
    <div role="group" aria-labelledby={titleId} data-slot="assistant-approval" className="flex flex-col gap-3 rounded-lg border border-warning/60 bg-card p-3 text-card-foreground shadow-sm">
      <div className="flex items-start gap-2">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p id={titleId} className="text-sm font-medium">
            Allow “{title}”?
          </p>
          <p className="text-xs text-muted-foreground">The assistant wants to change something in the app. Nothing happens until you approve.</p>
        </div>
      </div>
      {entries.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border border-border-subtle bg-muted/40 px-2.5 py-2 text-xs">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="truncate font-mono text-foreground" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onPress={() => controller.approve(call.id, true)}>
          <CheckIcon data-icon="inline-start" />
          Approve
        </Button>
        <Button size="sm" variant="outline" onPress={() => controller.approve(call.id, false)}>
          <XIcon data-icon="inline-start" />
          Deny
        </Button>
        <Button size="sm" variant="link" className="ms-auto" onPress={() => controller.approve(call.id, true, { always: true })}>
          Always allow in this chat
        </Button>
      </div>
    </div>
  );
});
