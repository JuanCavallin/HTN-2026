import { useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import { toast } from 'sonner';
import { History, Home as HomeIcon, Pencil, Play, Presentation, Workflow } from 'lucide-react';
import { api } from '../../lib/api';
import { useGraphs } from '../../hooks/useGraph';
import { useRuns } from '../../hooks/useRuns';
import { humanStatus, relativeTime } from '../../lib/format';

/** Same demo input Home and GraphEditor launch with. */
const DEMO_TARGET = 'ACME-2026-TERM-FEES';

const ITEM =
  'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-slate-300 ' +
  'data-[selected=true]:bg-slate-800 data-[selected=true]:text-slate-50';

const HEADING =
  '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 ' +
  '[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium ' +
  '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider ' +
  '[&_[cmdk-group-heading]]:text-slate-500';

export function CommandPalette({
  open,
  onOpenChange,
  present,
  onTogglePresent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  present: boolean;
  onTogglePresent: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      overlayClassName="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm animate-fade-in"
      contentClassName="fixed left-1/2 top-[18%] z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/60 animate-page-in"
    >
      {/* Only mounted while open, so the run/graph fetches (and the run-list
          SSE connection) happen on demand rather than on every page. */}
      <PaletteBody
        close={() => onOpenChange(false)}
        present={present}
        onTogglePresent={onTogglePresent}
      />
    </Command.Dialog>
  );
}

function PaletteBody({
  close,
  present,
  onTogglePresent,
}: {
  close: () => void;
  present: boolean;
  onTogglePresent: () => void;
}) {
  const navigate = useNavigate();
  const { graphs } = useGraphs();
  const { runs } = useRuns();

  const go = (to: string) => {
    close();
    navigate(to);
  };

  const launch = async (graphId: string, name: string) => {
    close();
    try {
      const { run } = await api.runGraph(graphId, { target: DEMO_TARGET });
      toast.success('Started ' + name);
      navigate('/runs/' + run.id);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <>
      <Command.Input
        autoFocus
        placeholder="Jump to a run or graph, or launch a task…"
        className="w-full border-b border-slate-800 bg-transparent px-4 py-3 text-sm text-slate-100 outline-none placeholder:text-slate-500"
      />
      <Command.List className={'max-h-80 overflow-y-auto p-1.5 ' + HEADING}>
        <Command.Empty className="px-3 py-6 text-center text-sm text-slate-500">
          Nothing matches.
        </Command.Empty>

        <Command.Group heading="Go to">
          <Item icon={<HomeIcon className="h-4 w-4" />} onSelect={() => go('/')}>
            Runs
          </Item>
          <Item icon={<Workflow className="h-4 w-4" />} onSelect={() => go('/graphs')}>
            Graph editor
          </Item>
          <Item
            icon={<Presentation className="h-4 w-4" />}
            value="presentation mode present demo"
            onSelect={() => {
              close();
              onTogglePresent();
            }}
          >
            {present ? 'Exit presentation mode' : 'Presentation mode'}
          </Item>
        </Command.Group>

        {graphs.length > 0 && (
          <Command.Group heading="Launch a task">
            {graphs.map((graph) => (
              <Item
                key={'launch-' + graph.id}
                value={'launch ' + graph.name}
                icon={<Play className="h-4 w-4 text-emerald-400" />}
                onSelect={() => void launch(graph.id, graph.name)}
              >
                {graph.name}
              </Item>
            ))}
          </Command.Group>
        )}

        {graphs.length > 0 && (
          <Command.Group heading="Edit a graph">
            {graphs.map((graph) => (
              <Item
                key={'edit-' + graph.id}
                value={'edit ' + graph.name}
                icon={<Pencil className="h-4 w-4" />}
                onSelect={() => go('/graphs/' + graph.id)}
              >
                {graph.name}
              </Item>
            ))}
          </Command.Group>
        )}

        {runs.length > 0 && (
          <Command.Group heading="Recent runs">
            {runs.slice(0, 8).map((run) => (
              <Item
                key={run.id}
                value={run.title + ' ' + run.id}
                icon={<History className="h-4 w-4" />}
                onSelect={() => go('/runs/' + run.id)}
              >
                <span className="truncate">{run.title}</span>
                <span className="ml-auto shrink-0 text-xs text-slate-500">
                  {humanStatus(run.status)} · {relativeTime(run.createdAt)}
                </span>
              </Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </>
  );
}

function Item({
  icon,
  children,
  onSelect,
  value,
}: {
  icon: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  value?: string;
}) {
  return (
    <Command.Item value={value} onSelect={onSelect} className={ITEM}>
      <span className="text-slate-400">{icon}</span>
      {children}
    </Command.Item>
  );
}
