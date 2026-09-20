import { useEffect, useState } from 'react';

const KEY = 'htn.present';

/**
 * Presentation mode: scales the whole UI up (everything is rem-based) so it
 * reads from the back of a room. Sticky across reloads.
 */
export function usePresentation() {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    document.documentElement.toggleAttribute('data-present', on);
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* private mode -- the toggle still works for this session */
    }
  }, [on]);

  return [on, setOn] as const;
}
