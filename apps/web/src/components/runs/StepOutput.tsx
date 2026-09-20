/**
 * Typed rendering of Step.output, by step.kind.
 *
 * `Step.output` is `Json` -- TypeScript cannot see the per-kind shape the
 * interpreter actually writes (see interpreter.ts / orchestrator.ts's various
 * `ctx.step()` callbacks, which is what Step.output literally is: whatever
 * that callback returned). Every renderer below re-derives its own
 * assumptions at runtime and falls back to the same generic JSON view
 * everything used to get if the shape doesn't match -- a step kind this file
 * doesn't know about, or one whose data doesn't look like what's expected,
 * degrades to readable JSON rather than rendering nothing or crashing.
 */

import type { Json } from '@htn/shared';

function isRecord(value: Json): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: Json | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: Json | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function pct(confidence: number): string {
  return Math.round(confidence * 100) + '%';
}

const proseClass =
  'mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded border-l-2 border-slate-700 bg-slate-950/40 px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-300';
const lineClass = 'mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400';
const jsonClass =
  'mt-1 max-h-24 overflow-auto rounded bg-slate-950/60 px-2 py-1 text-[11px] leading-relaxed text-slate-500';

function Raw({ value }: { value: Json }) {
  return <pre className={jsonClass}>{JSON.stringify(value, null, 1)}</pre>;
}

/**
 * `{tool, status, receivedArgs}` -- what the toolbox provider's `callTool`
 * actually returns (composio's live adapter is not implemented, so this
 * mock shape is, in practice, the only shape a successful call ever has).
 * Used directly for `tool`/`submit`, and nested inside `dispatch`'s result.
 */
function ToolResult({ value }: { value: Json }) {
  if (!isRecord(value)) return <Raw value={value} />;
  const tool = str(value.tool);
  if (tool === undefined) return <Raw value={value} />;

  const status = value.status;
  const ok = status !== 'error' && status !== 'failed';
  const args = Array.isArray(value.receivedArgs)
    ? value.receivedArgs.filter((a): a is string => typeof a === 'string')
    : undefined;

  return (
    <div className={lineClass}>
      <span className={ok ? 'text-emerald-400' : 'text-rose-400'}>{ok ? '✓' : '✗'}</span>
      <span className="font-mono text-slate-300">{tool}</span>
      {args && args.length > 0 && <span className="text-slate-600">args: {args.join(', ')}</span>}
    </div>
  );
}

export function StepOutput({ kind, output }: { kind: string; output: Json }) {
  switch (kind) {
    case 'decide': {
      // runDecide's step callback returns the raw completion text directly.
      const text = str(output);
      return text !== undefined ? <div className={proseClass}>{text}</div> : <Raw value={output} />;
    }

    case 'fetch': {
      if (!isRecord(output)) return <Raw value={output} />;
      const bytes = num(output.bytes);
      const source = str(output.source);
      return (
        <div className={lineClass}>
          <span>loaded</span>
          {bytes !== undefined && <span className="font-mono text-slate-300">{bytes}b</span>}
          {source && <span className="truncate font-mono">{source}</span>}
        </div>
      );
    }

    case 'redact': {
      if (!isRecord(output)) return <Raw value={output} />;
      const spans = num(output.spans) ?? 0;
      return (
        <div className={lineClass}>
          {spans > 0 ? (
            <>
              <span className="text-amber-400">◐</span>
              <span>
                {spans} sensitive span{spans === 1 ? '' : 's'} redacted
              </span>
            </>
          ) : (
            <span className="text-slate-600">no sensitive data found</span>
          )}
        </div>
      );
    }

    case 'judge': {
      if (!isRecord(output)) return <Raw value={output} />;
      const choice = str(output.choice);
      const confidence = num(output.confidence);
      if (choice === undefined) return <Raw value={output} />;
      return (
        <div className={lineClass}>
          <span className="text-amber-300">chose:</span>
          <span className="font-mono">{choice}</span>
          {confidence !== undefined && <span className="text-slate-600">({pct(confidence)})</span>}
        </div>
      );
    }

    case 'tool':
    case 'submit':
      return <ToolResult value={output} />;

    case 'dispatch': {
      if (!isRecord(output)) return <Raw value={output} />;
      const tool = str(output.tool);
      const confidence = num(output.confidence);
      return (
        <div>
          <div className={lineClass}>
            <span className="text-amber-300">selected:</span>
            {tool && <span className="font-mono">{tool}</span>}
            {confidence !== undefined && (
              <span className="text-slate-600">({pct(confidence)})</span>
            )}
          </div>
          {output.result !== undefined && <ToolResult value={output.result} />}
        </div>
      );
    }

    case 'approval':
      return (
        <div className={lineClass}>
          <span className="text-emerald-400">✓ approved</span>
        </div>
      );

    case 'agent_task': {
      if (!isRecord(output)) return <Raw value={output} />;
      const result = output.result;
      const text = isRecord(result) ? str(result.text) : str(result);
      const toolCalls = Array.isArray(output.toolCalls) ? output.toolCalls : [];
      const toolNames = toolCalls
        .map((c) => (isRecord(c) ? str(c.tool) : undefined))
        .filter((t): t is string => t !== undefined);

      return (
        <div className="space-y-1">
          {text !== undefined ? (
            <div className={proseClass}>{text}</div>
          ) : result !== undefined && result !== null ? (
            <Raw value={result} />
          ) : null}
          {toolNames.length > 0 && (
            <div className={lineClass}>
              <span className="text-zinc-500">
                {toolNames.length} tool call{toolNames.length === 1 ? '' : 's'}:
              </span>
              <span className="truncate font-mono text-slate-500">{toolNames.join(', ')}</span>
            </div>
          )}
        </div>
      );
    }

    case 'worker': {
      // Swarm workers are rendered by SwarmGrid, not StepRow -- this only
      // covers a worker step reached some other way (e.g. a future direct
      // link into one).
      if (!isRecord(output)) return <Raw value={output} />;
      const result = output.result;
      if (result === null || result === undefined) return null;
      if (typeof result === 'string') return <div className={proseClass}>{result}</div>;
      return <ToolResult value={result} />;
    }

    default:
      return <Raw value={output} />;
  }
}
