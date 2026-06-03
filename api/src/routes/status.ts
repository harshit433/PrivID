import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import {
  deleteStatusMediaByUrl,
  generateStatusUploadUrl,
  resolveStatusMediaUrl,
  uploadStatusImageBuffer,
} from '../services/s3';
import {
  STATUS_MAX_TEXT_LEN,
  STATUS_MAX_VIDEO_MS,
  STATUS_TTL_HOURS,
} from '../services/statusMedia';

export const statusRouter = Router();

type StatusRow = {
  status_id: string;
  user_id: string;
  type: 'text' | 'image' | 'video';
  text_body: string | null;
  media_url: string | null;
  media_content_type: string | null;
  duration_ms: number | null;
  created_at: string;
  expires_at: string;
};

async function mapItem(row: StatusRow) {
  return {
    status_id: row.status_id,
    type: row.type,
    text_body: row.text_body,
    media_url: await resolveStatusMediaUrl(row.media_url),
    media_content_type: row.media_content_type,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

async function mapItems(rows: StatusRow[]) {
  return Promise.all(rows.map(mapItem));
}

async function canViewUserStatus(viewerId: string, ownerId: string): Promise<boolean> {
  if (viewerId === ownerId) return true;
  const row = await queryOne<{ ok: number }>(
    `SELECT 1 AS ok
     WHERE EXISTS (
       SELECT 1 FROM connections
       WHERE owner_id = $1 AND contact_id = $2 AND connection_type != 'blocked'
     )
     OR EXISTS (
       SELECT 1 FROM connections
       WHERE owner_id = $2 AND contact_id = $1 AND connection_type != 'blocked'
     )
     LIMIT 1`,
    [viewerId, ownerId],
  );
  return Boolean(row?.ok);
}

// ─── GET /status/feed ─────────────────────────────────────────────────────────

statusRouter.get('/feed', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const viewerId = req.user!.sub;

    const users = await query<{
      user_id: string;
      handle: string;
      display_name: string | null;
      avatar_url: string | null;
      latest_at: string;
    }>(
      `SELECT u.user_id, u.handle, u.display_name, u.avatar_url, MAX(s.created_at) AS latest_at
       FROM user_status_updates s
       JOIN users u ON u.user_id = s.user_id
       WHERE s.expires_at > NOW()
         AND (
           u.user_id = $1
           OR EXISTS (
             SELECT 1 FROM connections c
             WHERE c.owner_id = $1 AND c.contact_id = u.user_id AND c.connection_type != 'blocked'
           )
           OR EXISTS (
             SELECT 1 FROM connections c
             WHERE c.contact_id = $1 AND c.owner_id = u.user_id AND c.connection_type != 'blocked'
           )
         )
       GROUP BY u.user_id, u.handle, u.display_name, u.avatar_url
       ORDER BY (u.user_id = $1) DESC, latest_at DESC`,
      [viewerId],
    );

    if (users.length === 0) {
      return res.json({ ok: true, data: [] });
    }

    const userIds = users.map((u) => u.user_id);
    const items = await query<StatusRow>(
      `SELECT status_id, user_id, type, text_body, media_url, media_content_type,
              duration_ms, created_at, expires_at
       FROM user_status_updates
       WHERE user_id = ANY($1::uuid[]) AND expires_at > NOW()
       ORDER BY user_id, created_at ASC`,
      [userIds],
    );

    const mappedItems = await mapItems(items);
    const byUser = new Map<string, Awaited<ReturnType<typeof mapItem>>[]>();
    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      const list = byUser.get(row.user_id) ?? [];
      list.push(mappedItems[i]);
      byUser.set(row.user_id, list);
    }

    const data = users.map((u) => ({
      user_id: u.user_id,
      handle: u.handle,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      is_mine: u.user_id === viewerId,
      items: byUser.get(u.user_id) ?? [],
      latest_at: u.latest_at,
    }));

    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

// ─── GET /status/me ───────────────────────────────────────────────────────────

statusRouter.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await query<StatusRow>(
      `SELECT status_id, user_id, type, text_body, media_url, media_content_type,
              duration_ms, created_at, expires_at
       FROM user_status_updates
       WHERE user_id = $1 AND expires_at > NOW()
       ORDER BY created_at ASC`,
      [req.user!.sub],
    );
    res.json({ ok: true, data: await mapItems(rows) });
  } catch (err) {
    next(err);
  }
});

// ─── GET /status/users/:userId ─────────────────────────────────────────────────

statusRouter.get('/users/:userId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerId = req.params.userId;
    if (!(await canViewUserStatus(req.user!.sub, ownerId))) {
      throw new AppError(403, 'FORBIDDEN', 'You cannot view this status.');
    }

    const user = await queryOne<{
      user_id: string;
      handle: string;
      display_name: string | null;
      avatar_url: string | null;
    }>(
      `SELECT user_id, handle, display_name, avatar_url FROM users WHERE user_id = $1`,
      [ownerId],
    );
    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found.');

    const rows = await query<StatusRow>(
      `SELECT status_id, user_id, type, text_body, media_url, media_content_type,
              duration_ms, created_at, expires_at
       FROM user_status_updates
       WHERE user_id = $1 AND expires_at > NOW()
       ORDER BY created_at ASC`,
      [ownerId],
    );

    res.json({
      ok: true,
      data: {
        ...user,
        is_mine: ownerId === req.user!.sub,
        items: await mapItems(rows),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /status/upload-url ──────────────────────────────────────────────────

const uploadUrlSchema = z.object({
  content_type: z.string(),
  kind: z.enum(['image', 'video']),
});

statusRouter.post('/upload-url', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content_type, kind } = uploadUrlSchema.parse(req.body);
    const { uploadUrl, publicUrl } = await generateStatusUploadUrl(req.user!.sub, content_type, kind);
    res.json({ ok: true, data: { upload_url: uploadUrl, public_url: publicUrl } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    if (err instanceof Error && err.message.includes('not configured')) {
      return next(new AppError(503, 'S3_NOT_CONFIGURED', err.message));
    }
    next(err);
  }
});

// ─── POST /status ─────────────────────────────────────────────────────────────

const createTextSchema = z.object({
  type: z.literal('text'),
  text_body: z.string().min(1).max(STATUS_MAX_TEXT_LEN),
});

const createMediaSchema = z.object({
  type: z.enum(['image', 'video']),
  media_url: z.string().min(1).optional(),
  media_content_type: z.string().optional(),
  duration_ms: z.number().int().positive().max(STATUS_MAX_VIDEO_MS).optional(),
  image_base64: z.string().optional(),
  content_type: z.string().optional(),
});

statusRouter.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    let type: 'text' | 'image' | 'video';
    let textBody: string | null = null;
    let mediaUrl: string | null = null;
    let mediaContentType: string | null = null;
    let durationMs: number | null = null;

    const body = req.body as Record<string, unknown>;
    if (body.type === 'text') {
      const parsed = createTextSchema.parse(body);
      type = 'text';
      textBody = parsed.text_body.trim();
    } else {
      const parsed = createMediaSchema.parse(body);
      type = parsed.type;
      if (type === 'video') {
        if (!parsed.duration_ms) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Video status requires duration_ms (max 60000).');
        }
        durationMs = parsed.duration_ms;
      }

      if (parsed.image_base64 && type === 'image') {
        const contentType = parsed.content_type ?? 'image/jpeg';
        const raw = parsed.image_base64.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(raw, 'base64');
        mediaUrl = await uploadStatusImageBuffer(userId, buf, contentType);
        mediaContentType = contentType;
      } else if (parsed.media_url) {
        mediaUrl = parsed.media_url;
        mediaContentType = parsed.media_content_type ?? null;
      } else {
        throw new AppError(400, 'VALIDATION_ERROR', 'Media URL or image_base64 is required.');
      }
    }

    const [row] = await query<StatusRow>(
      `INSERT INTO user_status_updates
         (user_id, type, text_body, media_url, media_content_type, duration_ms, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' hours')::interval)
       RETURNING status_id, user_id, type, text_body, media_url, media_content_type,
                 duration_ms, created_at, expires_at`,
      [userId, type, textBody, mediaUrl, mediaContentType, durationMs, String(STATUS_TTL_HOURS)],
    );

    res.status(201).json({ ok: true, data: await mapItem(row) });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    if (err instanceof Error && /Unsupported|must be between/.test(err.message)) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.message));
    }
    next(err);
  }
});

// ─── DELETE /status/:statusId ─────────────────────────────────────────────────

statusRouter.delete('/:statusId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await queryOne<StatusRow>(
      `DELETE FROM user_status_updates
       WHERE status_id = $1 AND user_id = $2
       RETURNING status_id, user_id, type, text_body, media_url, media_content_type,
                 duration_ms, created_at, expires_at`,
      [req.params.statusId, req.user!.sub],
    );
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Status not found.');
    if (row.media_url) await deleteStatusMediaByUrl(row.media_url);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
