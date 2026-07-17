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

## Develop

```
cp .env.example .env   # dev defaults use provider mocks (MOCK_KYC etc.)
npm install
npm run dev            # core (tsc -w) + api + worker
```

## Conventions

- Every response uses the envelope `{ ok, data, meta? }` / `{ ok:false, error }`.
- List endpoints use cursor pagination (`?limit=&cursor=` → `meta.nextCursor`).
- Money/call mutations honour the `Idempotency-Key` header.
- Only `*.repository.ts` touches the DB; only the provider layer touches vendor SDKs.
- Errors are `AppError` from the `ERRORS` catalog in `core/http`.
