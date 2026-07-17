/**
 * One-time wiring that needs the DB or providers, run before the server accepts
 * traffic: dev key generation and the auth guard's user-loader + presence hooks.
 * Kept separate from createApp so tests can compose the app without side effects.
 */
import { configureAuth, ensureDevKeys, logger } from '@trustroute/core';
import { findAuthAccount, touchPresence } from './modules/users/users.repository';

export async function bootstrap(): Promise<void> {
  ensureDevKeys();
  configureAuth({ loadUser: findAuthAccount, touchPresence });
  logger.debug('api', 'bootstrap complete');
}
