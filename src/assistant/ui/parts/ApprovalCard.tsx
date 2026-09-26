import { memo, useId, useRef, useState, type ReactNode } from 'react';
import { BanIcon, CheckIcon, ShieldAlertIcon, XIcon } from 'lucide-react';
import { Button } from '@tecton/react/components/button';
import type { ToolCallPart } from '../../core/types';
import { usePanel } from '../context';
import { argsSummary, prettyJson } from '../format';
import { ToolStateIcon } from './ToolCalls';

function argEntries(args: unknown): [string, string][] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args === undefined ? [] : [['value', prettyJson(args)]];
  return Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .slice(0, 8)
    .map(([k, v]) => [k.replace(/_/g, ' '), typeof v === 'string' ? v : JSON.stringify(v)]);
}

const CARD_CLASS = 'flex flex-col gap-3 rounded-lg border border-warning/60 bg-card p-3 text-card-foreground shadow-sm outline-none';

function CardHeader({ id, title, note }: { id: string; title: string; note: string }) {
  return (
    <div className="flex items-start gap-2">
      <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p id={id} className="text-sm font-medium">
          {title}
        </p>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
    </div>
  );
}

/**
 * A tool call waiting for the person: what it will do (the tool's own
 * phrase for the call, else its title and arguments) and Approve / Deny /
 * always allow. Rendered in place of the call's activity row.
 */
export const ApprovalCard = memo(function ApprovalCard({ call }: { call: ToolCallPart }) {
  const { controller, toolTitle, describeCall } = usePanel();
  const titleId = useId();
  const described = describeCall(call);
  const entries = described ? [] : argEntries(call.args);
  return (
    <div role="group" aria-labelledby={titleId} data-slot="assistant-approval" className={CARD_CLASS}>
      <CardHeader
        id={titleId}
        title={described ? `${described}?` : `Allow “${toolTitle(call.name)}”?`}
        note="The assistant wants to change something in the app. Nothing happens until you approve."
      />
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

/** A row's answer, before the call runs: approved or denied here, and still waiting for its turn. */
type Decision = boolean | undefined;

function rowStatus(call: ToolCallPart, decision: Decision): { icon: ReactNode; text: string; tone?: 'error' } {
  if (call.state === 'awaiting-approval') {
    if (decision === true) return { icon: <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />, text: 'Approved' };
    if (decision === false) return { icon: <BanIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />, text: 'Denied' };
    return { icon: <ToolStateIcon state={call.state} />, text: 'Waiting' };
  }
  const icon = <ToolStateIcon state={call.state} interrupted={call.interrupted} />;
  switch (call.state) {
    case 'streaming':
    case 'running':
      return { icon, text: 'Running' };
    case 'done':
      return { icon, text: 'Done' };
    case 'error':
      return { icon, text: 'Failed', tone: 'error' };
    case 'denied':
      return { icon, text: 'Denied' };
    default:
      return { icon, text: call.interrupted ? 'Interrupted' : 'Cancelled' };
  }
}

/**
 * The calls of one step that wait for the person, as one card: a line per
 * call (what it will do, with its own Approve and Deny), then Approve all,
 * Deny all and always allow. A row answers in place (approved, running,
 * done, denied), so the card keeps its height until every call has run and
 * the reply shows them as its usual activity row.
 */
export const ApprovalGroup = memo(function ApprovalGroup({ calls }: { calls: ToolCallPart[] }) {
  const { controller, toolTitle, describeCall } = usePanel();
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const approveButtons = useRef(new Map<string, HTMLButtonElement>());
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const open = calls.filter((c) => c.state === 'awaiting-approval' && decisions[c.id] === undefined);
  const fresh = open.length === calls.length;

  const decide = (targets: ToolCallPart[], approved: boolean, always = false) => {
    if (!targets.length) return;
    const ids = new Set(targets.map((c) => c.id));
    setDecisions((d) => ({ ...d, ...Object.fromEntries(targets.map((c) => [c.id, approved])) }));
    // the buttons of an answered row go: focus moves to the next open row, else to the card (without scrolling: the view stays where the person is)
    const next = open.find((c) => !ids.has(c.id));
    (next ? approveButtons.current.get(next.id) : root.current)?.focus({ preventScroll: true });
    for (const c of targets) controller.approve(c.id, approved, always ? { always: true } : undefined);
  };

  return (
    <div ref={root} tabIndex={-1} role="group" aria-labelledby={titleId} data-slot="assistant-approval-group" className={CARD_CLASS}>
      <CardHeader id={titleId} title={`Allow ${calls.length} changes?`} note="Nothing happens until you approve. Approved changes run in order." />
      <ul className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle bg-muted/40">
        {calls.map((call) => {
          const described = describeCall(call);
          const title = described ?? toolTitle(call.name);
          const summary = described ? '' : argsSummary(call.args, 60);
          const name = summary ? `${title} (${summary})` : title;
          const status = rowStatus(call, decisions[call.id]);
          const waiting = call.state === 'awaiting-approval' && decisions[call.id] === undefined;
          return (
            <li key={call.id} data-slot="assistant-approval-row" data-state={waiting ? 'waiting' : call.state} className="flex h-8 min-w-0 items-center gap-2 ps-2.5 pe-1 text-xs">
              {status.icon}
              <span className="min-w-0 flex-1 truncate" title={name}>
                <span className="font-medium text-foreground">{title}</span>
                {summary && <span className="text-muted-foreground"> · {summary}</span>}
              </span>
              {waiting ? (
                <span className="flex shrink-0 gap-1">
                  <Button
                    ref={(el: HTMLButtonElement | null) => {
                      if (el) approveButtons.current.set(call.id, el);
                      else approveButtons.current.delete(call.id);
                    }}
                    size="xs"
                    variant="outline"
                    aria-label={`Approve: ${name}`}
                    onPress={() => decide([call], true)}
                  >
                    Approve
                  </Button>
                  <Button size="xs" variant="ghost" aria-label={`Deny: ${name}`} onPress={() => decide([call], false)}>
                    Deny
                  </Button>
                </span>
              ) : (
                <span className={status.tone === 'error' ? 'shrink-0 pe-1.5 text-destructive' : 'shrink-0 pe-1.5 text-muted-foreground'} title={call.error}>
                  {status.text}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" isDisabled={!open.length} onPress={() => decide(open, true)}>
          <CheckIcon data-icon="inline-start" />
          {fresh ? 'Approve all' : 'Approve the rest'}
        </Button>
        <Button size="sm" variant="outline" isDisabled={!open.length} onPress={() => decide(open, false)}>
          <XIcon data-icon="inline-start" />
          {fresh ? 'Deny all' : 'Deny the rest'}
        </Button>
        <Button size="sm" variant="link" className="ms-auto" isDisabled={!open.length} onPress={() => decide(open, true, true)}>
          Always allow these in this chat
        </Button>
      </div>
    </div>
  );
});
