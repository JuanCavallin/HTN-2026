/**
 * Playbook registry.
 *
 * TO SHIP THE PRODUCT IDEA: write `<kind>.playbook.ts` next to this file and add
 * one line to PLAYBOOKS below. That is the whole server-side cost of the pivot.
 */

import type { Playbook } from './types.js';
import { demoPlaybook } from './demo.playbook.js';

const PLAYBOOKS: Playbook<never>[] = [demoPlaybook as unknown as Playbook<never>];

const byKind = new Map<string, Playbook<never>>(PLAYBOOKS.map((p) => [p.kind, p]));

export function getPlaybook(kind: string): Playbook<never> | undefined {
  return byKind.get(kind);
}

export function listPlaybooks(): { kind: string; title: string }[] {
  return [...byKind.values()].map((p) => ({ kind: p.kind, title: p.title }));
}

export function hasPlaybook(kind: string): boolean {
  return byKind.has(kind);
}
