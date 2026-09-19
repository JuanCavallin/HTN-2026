import type { ReactNode } from 'react';
import { Nav } from './Nav';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full">
      <Nav />
      <main className="mx-auto w-full max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
