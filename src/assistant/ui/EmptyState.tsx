import { type ReactNode } from 'react';
import { ArrowRightIcon, KeyRoundIcon, LightbulbIcon, SparklesIcon } from 'lucide-react';
import { Bubble, BubbleContent } from '@tecton/react/components/bubble';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@tecton/react/components/empty';
import type { Suggestion } from '../core/types';
import { usePanel } from './context';
import { PresetGrid } from './settings/SettingsDialog';

function SuggestionCard({ suggestion, icon, onPick }: { suggestion: Suggestion; icon: ReactNode; onPick: () => void }) {
  return (
    <Bubble variant="outline" className="w-full max-w-full">
      <BubbleContent
        className="group/suggestion flex h-full w-full items-start gap-2.5 text-left text-pretty"
        render={(props) => <button {...props} type="button" onClick={onPick} />}
      >
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-4" aria-hidden>
          {icon ?? <LightbulbIcon />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm leading-snug font-medium text-foreground">{suggestion.label}</span>
          {suggestion.description && <span className="text-xs leading-snug text-muted-foreground">{suggestion.description}</span>}
        </span>
        <ArrowRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/suggestion:opacity-100 group-focus-visible/suggestion:opacity-100" aria-hidden />
      </BubbleContent>
    </Bubble>
  );
}

/** The empty chat: who the assistant is, what it can do, and four prompts to start from. */
export function EmptyState({ onSend }: { onSend: (text: string) => void }) {
  const { controller } = usePanel();
  const { host } = controller;
  const suggestions = (host.suggestions?.() ?? []).slice(0, 4);
  return (
    <div data-slot="assistant-empty" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Empty className="my-auto gap-6 px-4 py-8">
        <EmptyHeader className="gap-2">
          <EmptyMedia variant="icon" className="size-10 rounded-xl bg-primary text-primary-foreground">
            <SparklesIcon />
          </EmptyMedia>
          <EmptyTitle className="text-base">Ask {host.appName} anything</EmptyTitle>
          <EmptyDescription className="text-xs">
            Questions about what’s on screen and the data behind it, charts and tables on demand, and tasks it can do in the app for you.
          </EmptyDescription>
        </EmptyHeader>
        {suggestions.length > 0 && (
          <EmptyContent className="max-w-md">
            <ul aria-label="Suggestions" className="grid w-full grid-cols-1 gap-2 @sm:grid-cols-2">
              {suggestions.map((s) => (
                <li key={s.label} className="flex min-w-0">
                  <SuggestionCard suggestion={s} icon={s.icon && host.renderIcon ? host.renderIcon(s.icon) : null} onPick={() => onSend(s.prompt ?? s.label)} />
                </li>
              ))}
            </ul>
          </EmptyContent>
        )}
      </Empty>
    </div>
  );
}

/** No connection yet: the presets to start from; picking one opens the settings on it. */
export function Onboarding() {
  const { controller, openSettings } = usePanel();
  return (
    <div data-slot="assistant-onboarding" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Empty className="my-auto gap-5 px-4 py-8">
        <EmptyHeader className="gap-2">
          <EmptyMedia variant="icon" className="size-10 rounded-xl bg-primary text-primary-foreground">
            <KeyRoundIcon />
          </EmptyMedia>
          <EmptyTitle className="text-base">Connect a model</EmptyTitle>
          <EmptyDescription className="text-xs">
            {controller.host.appName}’s assistant runs in your browser with your own API key. Pick a provider to set it up.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="max-w-md">
          <PresetGrid featured className="w-full" onPick={(p) => openSettings({ section: 'connection', presetId: p.id })} />
          <p className="text-xs text-muted-foreground">Keys stay in this browser and are sent only to the provider you choose.</p>
        </EmptyContent>
      </Empty>
    </div>
  );
}
