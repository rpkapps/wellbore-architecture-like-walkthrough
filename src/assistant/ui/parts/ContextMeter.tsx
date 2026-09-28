import { useState } from 'react';
import { FoldVerticalIcon } from 'lucide-react';
import { Button } from '@tecton/react/components/button';
import { InputGroupButton } from '@tecton/react/components/input-group';
import { Popover, PopoverTrigger } from '@tecton/react/components/popover';
import { Progress } from '@tecton/react/components/progress';
import { Tooltip, TooltipTrigger } from '@tecton/react/components/tooltip';
import { CircularProgress } from '@tecton/react/tecton/circular-progress';
import { usePanel } from '../context';
import { compactNumber } from '../format';
import { shallowEqual, useAssistantSelector } from '../useAssistant';

/** The meter shows from this share of the context window on: below it there is nothing to think about. */
export const CONTEXT_METER_FROM = 0.5;
/** From here on the ring turns to the warning colour (never before). */
const WARN_FROM = 0.9;

/**
 * How full the model's context is: a small ring in the composer's toolbar,
 * shown only past half the window. Its tooltip says older messages are
 * summarised automatically; pressing it offers "Compact now".
 */
export function ContextMeter() {
  const { controller } = usePanel();
  const context = useAssistantSelector(controller, (s) => s.context, shallowEqual);
  const idle = useAssistantSelector(controller, (s) => s.status === 'ready' || s.status === 'error');
  const hasMessages = useAssistantSelector(controller, (s) => s.thread.messages.length > 1);
  const [open, setOpen] = useState(false);
  if (!context || context.window <= 0) return null;
  const share = Math.min(1, context.used / context.window);
  if (share <= CONTEXT_METER_FROM) return null;
  const pct = Math.round(share * 100);
  const label = context.compacting ? 'Compacting the conversation' : `Context ${pct}% used`;
  return (
    <PopoverTrigger isOpen={open} onOpenChange={setOpen}>
      <TooltipTrigger>
        <InputGroupButton size="xs" data-slot="assistant-context-meter" aria-label={`${label}. Context options`} className="gap-1 px-1.5 tabular-nums">
          <CircularProgress aria-label={label} size="xs" value={pct} isIndeterminate={context.compacting} color={share >= WARN_FROM ? 'warning' : 'default'} />
          {!context.compacting && <span className="text-[0.6875rem]">{pct}%</span>}
        </InputGroupButton>
        <Tooltip>{`${label} · older messages are summarised automatically`}</Tooltip>
      </TooltipTrigger>
      <Popover placement="top end" className="flex w-72 flex-col gap-3 p-3" aria-label="Context">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">Context {pct}% used</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {compactNumber(context.used)} / {compactNumber(context.window)} tokens
          </span>
        </div>
        <Progress aria-label="Context used" value={pct} className="w-full" />
        <p className="text-xs text-muted-foreground">
          When the conversation nears the model’s limit, older messages are summarised automatically so you can keep going. The full transcript stays here.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          isDisabled={!idle || context.compacting || !hasMessages}
          onPress={() => {
            controller.compact();
            setOpen(false);
          }}
        >
          <FoldVerticalIcon data-icon="inline-start" />
          Compact now
        </Button>
      </Popover>
    </PopoverTrigger>
  );
}
