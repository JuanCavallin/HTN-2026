/**
 * The canvas legend.
 *
 * Worth its space: the colours only communicate if someone can read them, and
 * the cost column is the argument the whole product makes -- a program and a
 * tool call are free, a decision is cheap, an agent harness is not.
 */

import { EXECUTOR_STYLE } from '@htn/shared';
import { EXECUTOR_CLASSES, EXECUTOR_ORDER } from './palette';

const COST_LABEL: Record<string, string> = {
  none: 'no tokens',
  cheap: '~1 cheap call',
  moderate: '1 completion',
  high: 'many, opaque',
};

export function Legend({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-slate-400">
      {EXECUTOR_ORDER.map((executor) => {
        const style = EXECUTOR_STYLE[executor];
        return (
          <span
            key={executor}
            className="inline-flex items-center gap-1.5"
            title={style.description}
          >
            <span
              className={
                'h-2 w-2 rounded-sm ' +
                EXECUTOR_CLASSES[executor].dot +
                (style.opaque ? ' outline outline-1 outline-dashed outline-offset-1' : '')
              }
            />
            <span className="text-slate-300">{style.label}</span>
            {!compact && <span className="text-slate-600">{COST_LABEL[style.cost]}</span>}
          </span>
        );
      })}
      {!compact && (
        <span className="text-slate-600">dashed border = we cannot see inside the loop</span>
      )}
    </div>
  );
}
