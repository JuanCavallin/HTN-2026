import type { RunStatus, StepStatus } from '@htn/shared';

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return seconds + 's ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  return Math.round(minutes / 60) + 'h ago';
}

export function duration(startedAt?: string, endedAt?: string): string {
  if (!startedAt) return '';
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
}

export const RUN_STATUS_TONE: Record<RunStatus, 'ok' | 'warn' | 'bad' | 'muted' | 'accent'> = {
  pending: 'muted',
  running: 'accent',
  awaiting_approval: 'warn',
  succeeded: 'ok',
  failed: 'bad',
  cancelled: 'muted',
};

export const STEP_STATUS_TONE: Record<StepStatus, 'ok' | 'warn' | 'bad' | 'muted' | 'accent'> = {
  pending: 'muted',
  running: 'accent',
  blocked: 'warn',
  succeeded: 'ok',
  failed: 'bad',
  skipped: 'muted',
};

export function humanStatus(status: string): string {
  return status.replace(/_/g, ' ');
}
