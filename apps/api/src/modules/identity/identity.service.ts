/**
 * Identity classification for onboarding. Given a verified document hash, decide the
 * branch the app should take: a brand-new identity, a recreatable self-deleted one,
 * an existing active account, or a blocked (suspended/banned/ousted) identity.
 */
import * as repo from './identity.repository';
import type { IdentityRow } from './identity.repository';

export type IdentityBranch =
  | 'new'
  | 'self_deleted'
  | 'active'
  | 'suspended'
  | 'banned'
  | 'ousted';

export interface Classification {
  branch: IdentityBranch;
  identity: IdentityRow | null;
}

export async function classify(docHash: string): Promise<Classification> {
  const identity = await repo.findByDocHash(docHash);
  if (!identity) return { branch: 'new', identity: null };
  switch (identity.status) {
    case 'active':
      return { branch: 'active', identity };
    case 'self_deleted':
      return { branch: 'self_deleted', identity };
    case 'suspended':
      return { branch: 'suspended', identity };
    case 'banned':
      return { branch: 'banned', identity };
    case 'ousted':
      return { branch: 'ousted', identity };
    default:
      return { branch: 'active', identity };
  }
}

export { repo as identityRepo };
