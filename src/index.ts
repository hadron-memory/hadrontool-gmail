/**
 * Boot: env validation (config.ts import throws on production misconfig),
 * HTTP server, and the watch renewal / history sweep worker.
 */
import { createApp } from './app.js';
import { config } from './config.js';
import { db } from './db.js';
import { forwardEventToCore } from './events/forwarder.js';
import { startRenewalWorker } from './jobs/renewal.js';
import { logInfo } from './logger.js';
import { gmailProvider } from './providers/gmail/client.js';

const app = createApp(db, gmailProvider, forwardEventToCore);

app.listen(config.port, () => {
  logInfo(`hadrontool-gmail listening on :${config.port}`);
  if (!config.googleClientId || !config.googleClientSecret) {
    logInfo('GOOGLE_CLIENT_ID/SECRET not set — provider calls will return provider_not_configured');
  }
});

startRenewalWorker(db, gmailProvider, forwardEventToCore);
