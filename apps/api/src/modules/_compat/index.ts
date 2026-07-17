/**
 * Mobile-compatibility layer (P9 cutover). Re-exposes the legacy route surface the current
 * mobile app calls — built against the old backend's layout — delegating to the v2 modules.
 * Once the mobile client migrates to native v2 paths, delete this directory and its
 * registration in ../index.ts.
 *
 * Namespaces: /me, /trust, /shares, /numbers, /subscriptions, /chats, /payout-methods,
 * /payouts, and the fall-through /referrals paths. Response casing + the {ok,data} envelope
 * are handled globally by the boundary transform, so these routes only bridge PATHS.
 */
import type { Express } from 'express';
import { register as registerMe } from './me.routes';
import { register as registerTrust } from './trust.routes';
import { register as registerShares } from './shares.routes';
import { register as registerNumbers } from './numbers.routes';
import { register as registerSubscriptions } from './subscriptions.routes';
import { register as registerChats } from './chats.routes';
import { register as registerPayouts } from './payouts.routes';
import { register as registerReferralsCompat } from './referrals.routes';

export function registerCompat(app: Express): void {
  registerMe(app);
  registerTrust(app);
  registerShares(app);
  registerNumbers(app);
  registerSubscriptions(app);
  registerChats(app);
  registerPayouts(app);
  registerReferralsCompat(app); // must be after native /referrals (registered earlier)
}
