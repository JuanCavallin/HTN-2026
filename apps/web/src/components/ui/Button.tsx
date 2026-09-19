import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-sky-500 text-slate-950 hover:bg-sky-400 disabled:bg-slate-700 disabled:text-slate-500',
  ghost: 'bg-transparent text-slate-300 ring-1 ring-inset ring-slate-700 hover:bg-slate-800',
  danger:
    'bg-rose-500/90 text-white hover:bg-rose-500 disabled:bg-slate-700 disabled:text-slate-500',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

export function Button({ variant = 'primary', className = '', children, ...rest }: Props) {
  return (
    <button
      {...rest}
      className={
        'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ' +
        VARIANTS[variant] +
        ' ' +
        className
      }
    >
      {children}
    </button>
  );
}
