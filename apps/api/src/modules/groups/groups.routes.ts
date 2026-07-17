/**
 * Groups routes (all authenticated). Membership + role checks live in the service.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAuth, apiLimiter } from '@trustroute/core';
import { createBody, updateBody, addMembersBody, setRoleBody, groupIdParam, memberParam } from './groups.schema';
import * as groups from './groups.service';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    sendOk(res, await groups.list(req.user!.sub));
  }),
);

router.post(
  '/',
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await groups.create(req.user!.sub, req.valid.body as Parameters<typeof groups.create>[1]), {
      status: 201,
    });
  }),
);

router.get(
  '/:groupId',
  validate({ params: groupIdParam }),
  asyncHandler(async (req, res) => {
    const { groupId } = req.valid.params as { groupId: string };
    sendOk(res, await groups.get(req.user!.sub, groupId));
  }),
);

router.patch(
  '/:groupId',
  validate({ params: groupIdParam, body: updateBody }),
  asyncHandler(async (req, res) => {
    const { groupId } = req.valid.params as { groupId: string };
    sendOk(res, await groups.update(req.user!.sub, groupId, req.valid.body as Record<string, unknown>));
  }),
);

router.delete(
  '/:groupId',
  validate({ params: groupIdParam }),
  asyncHandler(async (req, res) => {
    const { groupId } = req.valid.params as { groupId: string };
    sendOk(res, await groups.remove(req.user!.sub, groupId));
  }),
);

router.post(
  '/:groupId/members',
  validate({ params: groupIdParam, body: addMembersBody }),
  asyncHandler(async (req, res) => {
    const { groupId } = req.valid.params as { groupId: string };
    const { handles } = req.valid.body as { handles: string[] };
    sendOk(res, await groups.addMembers(req.user!.sub, groupId, handles));
  }),
);

router.post(
  '/:groupId/role',
  validate({ params: groupIdParam, body: setRoleBody }),
  asyncHandler(async (req, res) => {
    const { groupId } = req.valid.params as { groupId: string };
    const { userId, role } = req.valid.body as { userId: string; role: 'admin' | 'member' };
    sendOk(res, await groups.setRole(req.user!.sub, groupId, userId, role));
  }),
);

router.delete(
  '/:groupId/members/:userId',
  validate({ params: memberParam }),
  asyncHandler(async (req, res) => {
    const { groupId, userId } = req.valid.params as { groupId: string; userId: string };
    sendOk(res, await groups.removeMember(req.user!.sub, groupId, userId));
  }),
);

router.post(
  '/:groupId/leave',
  validate({ params: groupIdParam }),
  asyncHandler(async (req, res) => {
    const { groupId } = req.valid.params as { groupId: string };
    sendOk(res, await groups.leave(req.user!.sub, groupId));
  }),
);

export function register(app: Express): void {
  app.use('/groups', apiLimiter, router);
}
