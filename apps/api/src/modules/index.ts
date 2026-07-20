/**
 * Module registry. Each domain module exports a `register(app)` that mounts its
 * router(s) under the right base path with the right guards. Added as built (P2+).
 */
import type { Express } from 'express';
import { register as registerAuth } from './auth/auth.routes';
import { register as registerOnboarding } from './onboarding/onboarding.routes';
import { register as registerUsers } from './users/users.routes';
import { register as registerConnections } from './connections/connections.routes';
import { register as registerReachability } from './reachability/reachability.routes';
import { register as registerCalls } from './calls/calls.routes';
import { register as registerMasked } from './masked/masked.routes';
import { register as registerChat } from './chat/chat.routes';
import { register as registerGroups } from './groups/groups.routes';
import { register as registerStatus } from './status/status.routes';
import { register as registerActivities } from './activities/activities.routes';
import { register as registerMedia } from './media/media.routes';
import { register as registerWallet } from './wallet/wallet.routes';
import { register as registerReferrals } from './referrals/referrals.routes';
import { register as registerReports } from './reports/reports.routes';
import { register as registerBusiness } from './business/business.routes';
import { register as registerAdmin } from './admin/admin.routes';
import { register as registerNotifications } from './notifications/notifications.routes';
import { register as registerConfig } from './config/config.routes';
import { register as registerAuthenticator } from './authenticator/authenticator.routes';
import { register as registerApprovals } from './approvals/approvals.routes';
import { register as registerSite } from './site/site.routes';
import { register as registerSimulation } from './simulation/simulation.routes';
import { registerCompat } from './_compat';

export function registerModules(app: Express): void {
  // P2
  registerAuth(app);
  registerOnboarding(app);
  // P3
  registerUsers(app);
  registerConnections(app);
  registerReachability(app);
  // P4
  registerCalls(app);
  registerMasked(app);
  // P5
  registerChat(app);
  registerGroups(app);
  registerStatus(app);
  registerActivities(app);
  registerMedia(app);
  // P6
  registerWallet(app);
  registerReferrals(app);
  registerReports(app);
  // P7
  registerBusiness(app);
  registerAdmin(app);
  registerNotifications(app);
  registerConfig(app);
  registerAuthenticator(app);
  registerApprovals(app);
  registerSite(app);
  // P8 — dev-only simulation/ML harness (self-guards on ENABLE_SIMULATION)
  registerSimulation(app);
  // P9 — mobile compatibility layer (legacy paths → v2 services). Registered last so the
  // native routes win; the /referrals compat only catches native fall-through paths.
  registerCompat(app);
}
