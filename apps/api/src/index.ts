import { createApp } from './app.js';
import { config, logConfigSummary } from './config.js';
import { store } from './store/index.js';

async function main(): Promise<void> {
  logConfigSummary();

  // No-op unless PERSIST_TO_DISK=true.
  await store.hydrate();

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
