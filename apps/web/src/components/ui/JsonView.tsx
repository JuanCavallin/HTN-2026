import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * Syntax-coloured, copyable JSON. Tokenised into React text nodes (never
 * innerHTML), so an arbitrary tool result can't inject markup.
 */

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));

    const [whole, str, colon, keyword] = match;
    let className: string;
    if (str !== undefined) {
      className = colon ? 'text-sky-300' : 'text-emerald-300';
      out.push(
        <span key={key++} className={className}>
          {str}
        </span>,
      );
      if (colon) out.push(colon);
    } else {
      className = keyword ? 'text-violet-300' : 'text-amber-300';
      out.push(
        <span key={key++} className={className}>
          {whole}
        </span>,
      );
    }
    last = index + whole.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function JsonView({ value, className = '' }: { value: unknown; className?: string }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(value, null, 2) ?? String(value);

  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => undefined);
  };

  return (
    <div className="group relative">
      <pre
        className={
          'overflow-auto rounded-md border border-white/5 bg-slate-950/80 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-400 ' +
          className
        }
      >
        {highlight(text)}
      </pre>
      <button
        type="button"
        onClick={copy}
        title="Copy JSON"
        aria-label="Copy JSON"
        className="absolute right-2 top-2 rounded border border-slate-700 bg-slate-900/90 p-1 text-slate-400 opacity-0 transition-opacity hover:text-slate-100 focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}
