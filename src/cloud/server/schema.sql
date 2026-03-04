-- claudemem cloud test server schema
-- PostgreSQL 16 + pgvector
-- No authentication tables — simplified for testing.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS orgs (
    id SERIAL PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repos (
    id SERIAL PRIMARY KEY,
    org_id INTEGER REFERENCES orgs(id),
    slug TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    embedding_dim INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(org_id, slug)
);

CREATE TABLE IF NOT EXISTS commits (
    id SERIAL PRIMARY KEY,
    repo_id INTEGER REFERENCES repos(id),
    sha TEXT NOT NULL,
    parent_shas TEXT[] DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    indexed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(repo_id, sha)
);

-- vector(8) for the test server: 8-dimensional synthetic vectors.
-- Production would use vector(1536) or similar.
CREATE TABLE IF NOT EXISTS chunks (
    id SERIAL PRIMARY KEY,
    content_hash TEXT UNIQUE NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    name TEXT,
    kind TEXT,
    language TEXT,
    chunk_type TEXT,
    content TEXT,
    text TEXT,
    vector vector(8),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commit_files (
    id SERIAL PRIMARY KEY,
    commit_id INTEGER REFERENCES commits(id),
    file_path TEXT NOT NULL,
    file_hash TEXT,
    chunk_hashes TEXT[] NOT NULL DEFAULT '{}',
    UNIQUE(commit_id, file_path)
);

CREATE TABLE IF NOT EXISTS enrichment_docs (
    id SERIAL PRIMARY KEY,
    content_hash TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    content TEXT NOT NULL,
    llm_model TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(content_hash, doc_type)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
CREATE INDEX IF NOT EXISTS idx_commit_files_commit_id ON commit_files(commit_id);
CREATE INDEX IF NOT EXISTS idx_commits_repo_sha ON commits(repo_id, sha);

-- API key storage
-- key_hash: SHA-256 hex of the full key (never stored in cleartext)
-- key_prefix: first 8 chars of the key after "cmem_" prefix (for display)
CREATE TABLE IF NOT EXISTS api_keys (
    id            SERIAL PRIMARY KEY,
    key_hash      TEXT UNIQUE NOT NULL,       -- SHA-256 hex of full key
    key_prefix    TEXT NOT NULL,              -- first 8 chars after "cmem_" prefix
    name          TEXT NOT NULL,              -- human label e.g. "CI deploy"
    created_at    TIMESTAMPTZ DEFAULT now(),
    last_used_at  TIMESTAMPTZ,
    is_active     BOOLEAN NOT NULL DEFAULT true
);

-- Per-request usage log (append-only)
CREATE TABLE IF NOT EXISTS api_key_usage (
    id           SERIAL PRIMARY KEY,
    key_id       INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    endpoint     TEXT NOT NULL,               -- e.g. "POST /v1/search"
    status_code  INTEGER NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_keys_hash       ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_key_usage_key   ON api_key_usage(key_id);
CREATE INDEX IF NOT EXISTS idx_api_key_usage_time  ON api_key_usage(created_at);
