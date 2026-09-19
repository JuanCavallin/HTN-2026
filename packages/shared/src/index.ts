/**
 * @htn/shared — the contract between apps/api and apps/web.
 *
 * This is the one file four people share. Treat it as a published API:
 * additive edits only, and announce in chat before changing an existing field.
 *
 * No runtime config, no secrets, no Node built-ins may be imported here —
 * this package is bundled into the browser.
 */

export * from './domain.js';
export * from './events.js';
export * from './policy.js';
export * from './providers.js';
export * from './schemas/index.js';
