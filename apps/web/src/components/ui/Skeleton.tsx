/** Shimmer placeholder. Size it with className (h-*, w-*). */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={'skeleton rounded-md ' + className} />;
}
