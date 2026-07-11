import { Router, Request, Response, NextFunction } from 'express';
import { getAppConfig } from '../services/appConfig';

export const configRouter = Router();

configRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getAppConfig();
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});
