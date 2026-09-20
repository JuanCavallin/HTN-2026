/**
 * Client-side id generation for graph nodes/edges created on the canvas.
 *
 * These ids only need to be unique within one graph document, never guessable
 * or collision-proof globally -- the server re-validates uniqueness in
 * agentGraphSchema on every save regardless, so this is a convenience, not a
 * guarantee.
 */

export function newClientId(prefix: string): string {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
