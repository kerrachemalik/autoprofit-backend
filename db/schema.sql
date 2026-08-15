-- AutoProfit — schéma PostgreSQL (compatible Supabase)
-- À exécuter une fois dans l'éditeur SQL de ton projet Supabase (ou via psql).

CREATE TABLE IF NOT EXISTS users (
  email           TEXT PRIMARY KEY,
  password_hash   TEXT NOT NULL,       -- bcrypt, jamais en clair
  is_premium      BOOLEAN NOT NULL DEFAULT false,
  analyses_count  INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id          SERIAL PRIMARY KEY,
  from_email  TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  message     TEXT NOT NULL,
  is_read     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analyses (
  id              SERIAL PRIMARY KEY,
  user_email      TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  vehicle_name    TEXT,
  plate           TEXT,
  purchase_price  NUMERIC,
  margin          NUMERIC,
  score           INTEGER,
  verdict         TEXT,
  -- Snapshot complet (véhicule, cote, comparables, verdict IA détaillé...) pour
  -- pouvoir rouvrir une analyse passée telle qu'elle était, sans la refaire.
  snapshot        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index pour le quota hebdomadaire (compter les analyses des 7 derniers jours par utilisateur)
CREATE INDEX IF NOT EXISTS idx_analyses_user_date ON analyses(user_email, created_at);

-- Index pour la boîte de réception admin (messages non lus en premier)
CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(is_read, created_at);
