/**
 * Connections request DTOs.
 */
import { z } from 'zod';
import { paginationQuery } from '@trustroute/core';

const handle = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._]{3,30}$/, 'Enter a valid @handle.');

export const listQuery = paginationQuery;

export const addBody = z.object({
  handle,
  connectionType: z.enum(['unknown', 'temporary', 'trusted']).optional(),
  contactName: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
  temporaryHours: z.number().int().min(1).max(24 * 30).optional(),
});

export const updateBody = z
  .object({
    connectionType: z.enum(['unknown', 'temporary', 'trusted']).optional(),
    contactName: z.string().trim().max(120).nullish(),
    notes: z.string().trim().max(500).nullish(),
    dailyCallLimit: z.number().int().min(0).max(1000).nullish(),
  })
  .strict();

export const blockBody = z.object({ handle });

export const contactIdParam = z.object({ contactId: z.string().uuid() });
