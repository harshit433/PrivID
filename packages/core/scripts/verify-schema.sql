\set ON_ERROR_STOP on

-- Table count (exclude migration bookkeeping)
SELECT 'tables' AS metric, count(*) AS n
FROM information_schema.tables
WHERE table_schema='public' AND table_type='BASE TABLE'
  AND table_name NOT LIKE '\_\_%' AND table_name <> '_migrations';

-- FK on-delete policy summary
SELECT confdeltype AS del, count(*) AS fks
FROM pg_constraint WHERE contype='f' GROUP BY confdeltype ORDER BY 1;

-- A: cascade (content) + set null (audit)
DO $$
DECLARE u1 uuid; u2 uuid; cnt int; tid uuid;
BEGIN
  INSERT INTO users (handle) VALUES ('vt_u1') RETURNING user_id INTO u1;
  INSERT INTO users (handle) VALUES ('vt_u2') RETURNING user_id INTO u2;
  INSERT INTO connections (owner_id, contact_id) VALUES (u1,u2);
  INSERT INTO admin_actions (target_id, action) VALUES (u2, 'warn') RETURNING action_id INTO tid;
  DELETE FROM users WHERE user_id=u1;
  SELECT count(*) INTO cnt FROM connections WHERE owner_id=u1;
  IF cnt<>0 THEN RAISE EXCEPTION 'FAIL cascade connections (got %)', cnt; END IF;
  DELETE FROM users WHERE user_id=u2;
  SELECT count(*) INTO cnt FROM admin_actions WHERE action_id=tid AND target_id IS NULL;
  IF cnt<>1 THEN RAISE EXCEPTION 'FAIL admin_actions SET NULL'; END IF;
  DELETE FROM admin_actions WHERE action_id=tid;
  RAISE NOTICE 'PASS  A: connections CASCADE + admin_actions SET NULL';
END $$;

-- B: one active account per identity
DO $$
DECLARE i uuid;
BEGIN
  INSERT INTO identities (legal_name, doc_hash) VALUES ('X','vt_hash') RETURNING identity_id INTO i;
  INSERT INTO users (handle, identity_id, account_status) VALUES ('vt_a', i, 'active');
  BEGIN
    INSERT INTO users (handle, identity_id, account_status) VALUES ('vt_b', i, 'active');
    RAISE EXCEPTION 'FAIL: duplicate active identity allowed';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS  B: one-active-identity enforced';
  END;
  DELETE FROM users WHERE handle IN ('vt_a','vt_b');
  DELETE FROM identities WHERE identity_id=i;
END $$;

-- C: trust_score CHECK
DO $$
BEGIN
  BEGIN
    INSERT INTO users (handle, trust_score) VALUES ('vt_c', 150);
    RAISE EXCEPTION 'FAIL: trust_score check not enforced';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS  C: trust_score CHECK enforced';
  END;
END $$;

-- D: updated_at trigger overrides a caller-supplied stale value
DO $$
DECLARE u uuid; t2 timestamptz;
BEGIN
  INSERT INTO users (handle) VALUES ('vt_upd') RETURNING user_id INTO u;
  -- Try to force a stale timestamp; the BEFORE UPDATE trigger must overwrite it with NOW().
  UPDATE users SET display_name='x', updated_at='2000-01-01' WHERE user_id=u;
  SELECT updated_at INTO t2 FROM users WHERE user_id=u;
  IF t2 < now() - interval '1 day' THEN RAISE EXCEPTION 'FAIL updated_at trigger did not override'; END IF;
  DELETE FROM users WHERE user_id=u;
  RAISE NOTICE 'PASS  D: updated_at trigger overrides stale value';
END $$;

-- E: reachability token auto-generated (pgcrypto default)
DO $$
DECLARE u uuid; tok text;
BEGIN
  INSERT INTO users (handle) VALUES ('vt_tok') RETURNING user_id INTO u;
  INSERT INTO reachability_channels (owner_id) VALUES (u) RETURNING token INTO tok;
  IF tok IS NULL OR length(tok) < 20 THEN RAISE EXCEPTION 'FAIL token default'; END IF;
  DELETE FROM users WHERE user_id=u;
  RAISE NOTICE 'PASS  E: reachability token default generated (len %)', length(tok);
END $$;
