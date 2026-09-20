import { useEffect } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';

/**
 * A number that counts to its new value instead of jumping. Used for the live
 * token / cost counters so a run visibly "spends" as it works.
 */
export function NumberTicker({
  value,
  decimals = 0,
  suffix = '',
  className = '',
}: {
  value: number;
  decimals?: number;
  suffix?: string;
  className?: string;
}) {
  const motionValue = useMotionValue(value);
  const text = useTransform(
    motionValue,
    (v) =>
      v.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }) + suffix,
  );

  useEffect(() => {
    const controls = animate(motionValue, value, { duration: 0.6, ease: 'easeOut' });
    return () => controls.stop();
  }, [motionValue, value]);

  return <motion.span className={'tabular-nums ' + className}>{text}</motion.span>;
}
