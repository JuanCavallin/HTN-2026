import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'primary-button',
  ghost: 'secondary-button',
  danger: 'secondary-button !text-rose-200 !border-rose-400/40',
};
interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

export function Button({ variant = 'primary', className = '', children, ...rest }: Props) {
  return (
    <button {...rest} className={VARIANTS[variant] + ' ' + className}>
      {children}
    </button>
  );
}
