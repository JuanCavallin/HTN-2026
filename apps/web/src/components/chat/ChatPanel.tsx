/**
 * The chat that authors a graph.
 *
 * It does not launch runs. Describing a workflow produces a DOCUMENT you can
 * read and edit before anything executes -- which is the whole point of the
 * graph existing, and the reason this is not just a prompt box wired to an
 * agent.
 *
 * EDITING THE GRAPH ON SCREEN, NOT A DIFFERENT ONE: a lazily-created
 * conversation must be seeded with `graphId` -- the graph currently loaded on
 * the page -- or its first message has no `currentGraph` on the server and
 * synthesis builds an unrelated new document instead of modifying what you are
 * looking at. See conversations.routes.ts.
 *
 * The delegation line under each reply is deliberate: it says what was left for
 * the decision layer and the harness to work out at runtime, so a graph that
 * has quietly pinned everything is visible rather than silently impressive.
 */

import { useEffect, useRef, useState } from 'react';
import type { AgentGraph, Conversation, GraphDelegation } from '@htn/shared';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';

const EXAMPLES = [
  'Check our vendor portals for overdue invoices and email me a summary',
  'Summarise the case document and redact any personal data first',
];

export function ChatPanel({
  conversation,
  graphId,
  onGraph,
  onConversation,
  className = '',
}: {
  conversation: Conversation | null;
  /** The graph currently open on the page. Seeds a new conversation so its
   *  first message edits THIS graph rather than building an unrelated one. */
  graphId?: string;
  onGraph: (graph: AgentGraph) => void;
  /** Also used with `null` by the "New chat" reset below. */
  onConversation: (conversation: Conversation | null) => void;
  className?: string;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delegation, setDelegation] = useState<GraphDelegation | null>(null);
  // "New chat" means build something UNRELATED to whatever is on screen, not
  // just clear the transcript -- otherwise the next message would still be
  // seeded with `graphId` and silently resume editing the same graph. Reset
  // whenever `graphId` itself changes, so switching graphs elsewhere on the
  // page goes back to defaulting to "edit what's now open".
  const [detached, setDetached] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDetached(false), [graphId]);

  const messages = conversation?.messages ?? [];

  // A chat UI that does not follow its own transcript reads as broken. Scroll
  // on every new message, not just while sending, so a page reload that
  // restores history also lands at the bottom.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, busy]);

  const send = async (message: string) => {
    if (!message.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      // A conversation is created lazily, so the page does not litter the store
      // with empty ones just because someone opened it. Seeded with the graph
      // on screen, so "add a step" edits that graph instead of forking one --
      // unless "New chat" explicitly detached from it.
      const seed = detached ? undefined : graphId;
      const id = conversation?.id ?? (await api.createConversation(seed)).conversation.id;
      const result = await api.sendMessage(id, message.trim());
      onConversation(result.conversation);
      onGraph(result.graph);
      setDelegation(result.delegation);
      setText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={'flex flex-col rounded-lg border border-slate-800 bg-slate-900/60 ' + className}
    >
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
        <h2 className="text-sm font-semibold text-slate-200">
          {conversation?.graphId && conversation.messages.length > 0
            ? 'Editing: ' + (conversation.title || 'this workflow')
            : 'Describe a workflow'}
        </h2>
        {messages.length > 0 && (
          <button
            onClick={() => {
              // Clears the transcript AND detaches from graphId -- the next
              // message builds a fresh, unrelated document rather than
              // continuing to edit whatever is open. The graph already built
              // stays on the canvas; only the chat resets.
              onConversation(null);
              setDetached(true);
              setDelegation(null);
              setError(null);
            }}
            disabled={busy}
            className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-50"
          >
            New chat
          </button>
        )}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-slate-500">
              Describe what you want done. You get a graph to review and edit — nothing runs until
              you launch it.
            </p>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                onClick={() => void send(example)}
                disabled={busy}
                className="block w-full rounded-md border border-slate-700 bg-slate-950/40 px-3 py-2 text-left text-xs text-slate-400 hover:border-slate-600 hover:text-slate-200 disabled:opacity-50"
              >
                {example}
              </button>
            ))}
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={
              message.role === 'user'
                ? 'ml-6 rounded-lg bg-sky-500/10 px-3 py-2 text-sm text-slate-200'
                : 'mr-6 rounded-lg bg-slate-800/60 px-3 py-2 text-sm text-slate-300'
            }
          >
            {message.text}
            {message.graphVersion !== undefined && (
              <span className="ml-2 text-[10px] text-slate-500">v{message.graphVersion}</span>
            )}
          </div>
        ))}

        {busy && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Spinner className="h-3 w-3" />
            Designing the workflow…
          </div>
        )}

        {error && <p className="text-xs text-rose-400">{error}</p>}
      </div>

      {delegation && (
        <div className="border-t border-slate-800 px-4 py-2 text-[11px] text-slate-500">
          <span className="text-slate-400">Left to runtime:</span> {delegation.deferredToolChoices}{' '}
          tool choice
          {delegation.deferredToolChoices === 1 ? '' : 's'} · {delegation.agentSubtasks} agent
          subtask{delegation.agentSubtasks === 1 ? '' : 's'} · {delegation.candidateTools}{' '}
          candidates to narrow
          {delegation.pinnedCalls > 0 && ' · ' + delegation.pinnedCalls + ' pinned'}
        </div>
      )}

      <div className="flex gap-2 border-t border-slate-800 p-3">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(text);
            }
          }}
          placeholder={messages.length === 0 ? 'Describe a workflow…' : 'Change something…'}
          disabled={busy}
          className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 disabled:opacity-50"
        />
        <Button onClick={() => void send(text)} disabled={busy || !text.trim()}>
          Send
        </Button>
      </div>
    </div>
  );
}
