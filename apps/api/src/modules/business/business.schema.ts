/**
 * Business request DTOs.
 */
import { z } from 'zod';
import { paginationQuery } from '@trustroute/core';

export const registerBody = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(80),
  contactEmail: z.string().trim().email().max(254),
  gstin: z.string().trim().length(15).optional(),
  cin: z.string().trim().max(30).optional(),
  website: z.string().url().max(512).optional(),
});

export const subscribeBody = z.object({ channelId: z.string().uuid() });
export const blockBody = z.object({ reason: z.string().trim().max(500).optional() });
export const reportBody = z.object({ reason: z.string().trim().max(500).optional() });

export const createChannelBody = z.object({
  name: z.string().trim().min(1).max(120),
  channelType: z.enum(['transactional', 'promotional', 'otp']),
  dailyLimitPerSubscriber: z.number().int().min(1).max(100).optional(),
});

export const broadcastBody = z.object({
  content: z.string().trim().min(1).max(4096),
  templateId: z.string().trim().max(80).optional(),
});

export const inboxQuery = paginationQuery;
export const businessIdParam = z.object({ businessId: z.string().uuid() });
export const subIdParam = z.object({ subscriptionId: z.string().uuid() });
export const channelIdParam = z.object({ channelId: z.string().uuid() });
