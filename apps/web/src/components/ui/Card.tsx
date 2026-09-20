import type { ReactNode } from 'react';

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={'surface-section ' + className}>
      {(title || actions) && (
        <header>
          <h2>{title}</h2>
          {actions}
        </header>
      )}
      <div>{children}</div>
    </section>
  );
}
