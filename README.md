# TrustRoute Backend v2

Clean, modular rewrite of the TrustRoute backend. See the design at
`~/.claude/plans/replicated-giggling-treasure.md`.

## Layout

```
packages/core        cross-cutting foundation (config, db, cache, http, auth,
                     validation, ratelimit, queue, logger, providers) — no domain logic
apps/api             HTTP API — modules/<domain>/{routes,service,repository,schema}
apps/worker          BullMQ processors + cron scheduler
```

## Data layer

Drizzle ORM. The schema in `packages/core/src/db/schema/*.ts` is the single source of
truth; migrations are generated from it (never hand-written).

```
npm run db:generate    # schema -> SQL migration
npm run db:migrate     # apply migrations
npm run db:reset       # DROP + reapply (dev only)
npm run db:seed        # feature flags + dev number pool
```

## Production (Railway)

Set `NODE_ENV=production`, leave `MOCK_KYC` / `MOCK_LIVENESS` false, and configure real providers. The provider factory wires real SDKs when credentials are present; in production, missing credentials throw at startup rather than silently mocking.

| Service | Required env vars |
|---------|-------------------|
| DigiLocker (Setu) | `SETU_DG_CLIENT_ID`, `SETU_DG_CLIENT_SECRET`, `SETU_DG_PRODUCT_INSTANCE_ID`, `SETU_DG_REDIRECT_URL` |
| Setu geo proxy (Railway SG → India) | `SETU_DG_PROXY_BASE_URL`, `SETU_DG_PROXY_SECRET` (deploy `backend/setu-proxy` on Fly Mumbai) |
| Liveness (Luxand) | `LUXAND_API_TOKEN` |
| Stream chat/video | `STREAM_API_KEY`, `STREAM_API_SECRET` |
| Firebase FCM + RTDB | `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_DATABASE_URL` |
| Razorpay top-ups | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| RazorpayX payouts | `RAZORPAYX_ACCOUNT_NUMBER` (+ same Razorpay keys) |
| Masked calling | `TELEPHONY_PROVIDER=exotel`, `EXOTEL_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN` |
| Media storage | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET` |

Also set `API_BASE_URL` to your Railway public URL (used for DigiLocker redirect fallback).

Health check: `GET /health` includes `providers.*_configured` flags.

## Develop

```
cp .env.example .env   # dev: leave provider vars blank to use mocks, or set MOCK_*=true
npm install
npm run dev            # core (tsc -w) + api + worker
```

## Conventions

- Every response uses the envelope `{ ok, data, meta? }` / `{ ok:false, error }`.
- List endpoints use cursor pagination (`?limit=&cursor=` → `meta.nextCursor`).
- Money/call mutations honour the `Idempotency-Key` header.
- Only `*.repository.ts` touches the DB; only the provider layer touches vendor SDKs.
- Errors are `AppError` from the `ERRORS` catalog in `core/http`.
