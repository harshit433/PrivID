/**
 * Connections routes (all authenticated). REST over the owner's address book plus
 * block/unblock. List returns the standard cursor-paginated envelope.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, sendPage, validate, requireAuth, apiLimiter } from '@trustroute/core';
import { listQuery, addBody, updateBody, blockBody, contactIdParam } from './connections.schema';
import * as connections from './connections.service';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { limit, cursor } = req.valid.query as { limit: number; cursor?: string };
    const { items, meta } = await connections.list(req.user!.sub, limit, cursor);
    sendPage(res, items, meta);
  }),
);

router.post(
  '/',
  validate({ body: addBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await connections.add(req.user!.sub, req.valid.body as Parameters<typeof connections.add>[1]), {
      status: 201,
    });
  }),
);

router.post(
  '/block',
  validate({ body: blockBody }),
  asyncHandler(async (req, res) => {
    const { handle } = req.valid.body as { handle: string };
    sendOk(res, await connections.block(req.user!.sub, handle));
  }),
);

router.get(
  '/:contactId',
  validate({ params: contactIdParam }),
  asyncHandler(async (req, res) => {
    const { contactId } = req.valid.params as { contactId: string };
    sendOk(res, await connections.get(req.user!.sub, contactId));
  }),
);

router.patch(
  '/:contactId',
  validate({ params: contactIdParam, body: updateBody }),
  asyncHandler(async (req, res) => {
    const { contactId } = req.valid.params as { contactId: string };
    sendOk(res, await connections.update(req.user!.sub, contactId, req.valid.body as Record<string, unknown>));
  }),
);

router.delete(
  '/:contactId',
  validate({ params: contactIdParam }),
  asyncHandler(async (req, res) => {
    const { contactId } = req.valid.params as { contactId: string };
    sendOk(res, await connections.remove(req.user!.sub, contactId));
  }),
);

router.post(
  '/:contactId/unblock',
  validate({ params: contactIdParam }),
  asyncHandler(async (req, res) => {
    const { contactId } = req.valid.params as { contactId: string };
    sendOk(res, await connections.unblock(req.user!.sub, contactId));
  }),
);

export function register(app: Express): void {
  app.use('/connections', apiLimiter, router);
}
