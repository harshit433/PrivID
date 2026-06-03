-- 012_search_indexes.sql
--
-- Indexes to support GET /users/search efficiently at scale.
--
-- pg_trgm (installed in 001) enables similarity() and ILIKE-with-GiST.
-- GiST indexes are chosen over GIN here because they support ordered scans
-- which the cursor-based pagination in the search endpoint uses.

-- ── Handle search (prefix + trigram) ─────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_handle_trgm
  ON users USING GiST (handle gist_trgm_ops);

-- ── Display-name fuzzy search ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_display_name_trgm
  ON users USING GiST (display_name gist_trgm_ops)
  WHERE display_name IS NOT NULL;

-- ── Fast public-user listing (discovery queries) ──────────────────────────────
-- Covers the WHERE clause filter before trigram scoring kicks in.
CREATE INDEX IF NOT EXISTS idx_users_discovery
  ON users (discovery_mode, is_active, handle)
  WHERE discovery_mode = 'public' AND is_active = TRUE;

-- ── Connection lookup used in privacy-aware search ────────────────────────────
-- "show me even private-mode users I am already connected to"
CREATE INDEX IF NOT EXISTS idx_connections_owner_contact
  ON connections (owner_id, contact_id, connection_type);
