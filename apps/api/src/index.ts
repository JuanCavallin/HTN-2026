import { createApp } from './app.js';
import { config, logConfigSummary } from './config.js';
import { seedGraphs } from './services/graphs.service.js';
import { loadToolClassifications } from './services/runtime.js';
import { store } from './store/index.js';

async function main(): Promise<void> {
  logConfigSummary();

  // No-op unless PERSIST_TO_DISK=true.
  await store.hydrate();

  // So the canvas is never empty on a cold start. Never overwrites an edit.
  await seedGraphs();

  // Seed the tool -> action-kind index the risk gate reads. Until this runs
  // every tool is unclassified and stops for a human, so it happens before the
  // server accepts a request.
  const classified = await loadToolClassifications();
  console.log('[tools] ' + classified + ' tool(s) classified for the risk gate');

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log('[api] listening on http://localhost:' + config.port);
    console.log('[api] health:    http://localhost:' + config.port + '/api/health');
    console.log('[api] providers: http://localhost:' + config.port + '/api/providers');
  });

  const shutdown = (signal: string): void => {
    console.log('[api] ' + signal + ' received, closing');
    server.close(() => process.exit(0));
    // Do not let a hung SSE connection block the exit.
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
