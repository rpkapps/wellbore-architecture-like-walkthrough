import { memo, useState } from 'react';
import { ChevronDownIcon, CircleAlertIcon, RotateCcwIcon, SettingsIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@tecton/react/components/alert';
import { Button } from '@tecton/react/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tecton/react/components/collapsible';
import type { ErrorPart } from '../../core/types';
import { usePanel } from '../context';

/** An error in the transcript: the message, the provider's detail on demand, Retry and (for settings errors) Open settings. */
export const ErrorNotice = memo(function ErrorNotice({ part, canRetry }: { part: ErrorPart; canRetry: boolean }) {
  const { controller, openSettings } = usePanel();
  const [open, setOpen] = useState(false);
  return (
    <Alert variant="destructive" data-slot="assistant-error">
      <CircleAlertIcon aria-hidden />
      <AlertTitle>{part.config ? 'Check the connection settings' : part.retryable ? 'The request failed' : 'Something went wrong'}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2 text-pretty">
        <div className="wrap-break-word">{part.message}</div>
        {part.detail && (
          <Collapsible isExpanded={open} onExpandedChange={setOpen} className="group/detail">
            <CollapsibleTrigger className="inline-flex items-center gap-1 rounded-sm text-xs underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              {open ? 'Hide details' : 'Show details'}
              <ChevronDownIcon className="size-3 transition-transform group-data-expanded/detail:rotate-180" aria-hidden />
            </CollapsibleTrigger>
            <CollapsibleContent>
              {open && <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-background/60 p-2 font-mono text-[0.6875rem] whitespace-pre-wrap break-all text-foreground">{part.detail}</pre>}
            </CollapsibleContent>
          </Collapsible>
        )}
        {(canRetry || part.config) && (
          <div className="mt-1 flex flex-wrap gap-2">
            {canRetry && (
              <Button size="xs" variant="outline" onPress={() => controller.regenerate()}>
                <RotateCcwIcon data-icon="inline-start" />
                Retry
              </Button>
            )}
            {part.config && (
              <Button size="xs" variant={canRetry ? 'ghost' : 'outline'} onPress={() => openSettings({ section: 'connection' })}>
                <SettingsIcon data-icon="inline-start" />
                Open settings
              </Button>
            )}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
});
