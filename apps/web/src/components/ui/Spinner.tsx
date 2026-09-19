export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="loading"
      className={
        'inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-400 border-t-transparent ' +
        className
      }
    />
  );
}
