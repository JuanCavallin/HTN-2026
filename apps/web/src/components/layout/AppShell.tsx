import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import { usePresentation } from '../../hooks/usePresentation';
import { CommandPalette } from './CommandPalette';
import { Nav } from './Nav';

/**
 * Graph and run pages carry a canvas beside panels, so they get more width than
 * the list pages. Nav shares the same width so its content lines up with main.
 */
function widthFor(pathname: string): string {
  return pathname.startsWith('/graphs') || pathname.startsWith('/runs') || pathname === '/compare'
    ? 'max-w-7xl'
    : 'max-w-5xl';
}

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [present, setPresent] = usePresentation();
  const width = widthFor(pathname);

  return (
    <div className="min-h-full">
      <Nav
        widthClass={width}
        onOpenPalette={() => setPaletteOpen(true)}
        present={present}
        onTogglePresent={() => setPresent((p) => !p)}
      />
      {/* Keyed on the path so each page fades up instead of snapping in. */}
      <main key={pathname} className={'mx-auto w-full animate-page-in px-4 py-6 ' + width}>
        {children}
      </main>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        present={present}
        onTogglePresent={() => setPresent((p) => !p)}
      />
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: '!border !border-slate-700 !bg-slate-900 !text-slate-100',
          },
        }}
      />
    </div>
  );
}
