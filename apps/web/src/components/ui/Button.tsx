import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-sky-500 text-slate-950 shadow-[0_0_0_1px_rgb(255_255_255/0.08)_inset] hover:bg-sky-400 active:bg-sky-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:shadow-none',
  ghost:
    'bg-transparent text-slate-300 ring-1 ring-inset ring-slate-700 hover:bg-slate-800 hover:text-slate-100 disabled:text-slate-600 disabled:hover:bg-transparent',
  danger:
    'bg-rose-500/90 text-white hover:bg-rose-500 active:bg-rose-600 disabled:bg-slate-700 disabled:text-slate-500',
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
        'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100 ' +
        VARIANTS[variant] +
        ' ' +
        className
      }
    >
      {children}
    </button>
  );
}
