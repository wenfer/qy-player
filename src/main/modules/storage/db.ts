import Database from 'better-sqlite3';
import { join } from 'path';
import { app } from 'electron';

const MIGRATIONS = [
  // Migration 001: Initial schema
  `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS local_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    title TEXT,
    duration INTEGER,
    file_size INTEGER,
    last_played INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS playback_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_type TEXT NOT NULL CHECK(media_type IN ('local', 'jellyfin', 'emby')),
    local_media_id INTEGER REFERENCES local_media(id),
    server_id TEXT,
    position REAL NOT NULL DEFAULT 0,
    duration REAL,
    is_finished INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS watch_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_type TEXT NOT NULL,
    media_id TEXT NOT NULL,
    title TEXT,
    poster_url TEXT,
    path TEXT,
    position REAL,
    duration REAL,
    watched_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('jellyfin', 'emby')),
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT,
    username TEXT,
    user_id TEXT,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER DEFAULT (unixepoch())
  );

  INSERT OR IGNORE INTO schema_version (version) VALUES (1);
  `,

  // Migration 002: Deduplicate watch_history and prevent future duplicates
  `
  -- Remove duplicate watch_history rows, keep only the latest per media
  DELETE FROM watch_history
  WHERE id NOT IN (
    SELECT MAX(id) FROM watch_history GROUP BY media_type, media_id
  );

  -- Remove duplicate playback_progress rows (grouped by type + server_id or local id)
  DELETE FROM playback_progress
  WHERE id NOT IN (
    SELECT MAX(id) FROM playback_progress
    GROUP BY media_type, IFNULL(server_id, 'local:' || local_media_id)
  );

  -- Unique index prevents future duplicate watch_history entries
  CREATE UNIQUE INDEX IF NOT EXISTS idx_watch_history_unique
    ON watch_history(media_type, media_id);
  `,

  // Migration 003: Backfill missing path for local watch_history rows
  // (older versions saved history without the path field)
  `
  UPDATE watch_history
  SET path = media_id
  WHERE media_type = 'local' AND (path IS NULL OR path = '');
  `,

  // Migration 004: Add episode context to watch_history
  `
  ALTER TABLE watch_history ADD COLUMN series_name TEXT;
  ALTER TABLE watch_history ADD COLUMN season_number INTEGER;
  ALTER TABLE watch_history ADD COLUMN episode_number INTEGER;
  `,

  // Migration 005: Phase-2 unified catalog schema (ADR-0001, plan §5).
  // Append-only: never edits 001-004; legacy tables and CHECKs stay intact.
  `
  CREATE TABLE IF NOT EXISTS library_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('local', 'webdav')),
    name TEXT NOT NULL,
    -- Root must never embed credentials ('@' rejects userinfo at the DB level).
    root TEXT NOT NULL CHECK(instr(root, '@') = 0),
    secret_ref TEXT,
    read_only INTEGER NOT NULL DEFAULT 1,
    options TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS catalog_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES library_sources(id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    parent_id INTEGER REFERENCES catalog_items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('movie', 'series', 'season', 'episode', 'video')),
    title TEXT,
    year INTEGER,
    season_number INTEGER,
    episode_number INTEGER,
    availability TEXT NOT NULL DEFAULT 'online' CHECK(availability IN ('online', 'offline', 'missing')),
    metadata_revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(source_id, source_key)
  );
  CREATE INDEX IF NOT EXISTS idx_catalog_items_parent ON catalog_items(parent_id);
  CREATE INDEX IF NOT EXISTS idx_catalog_items_source_kind ON catalog_items(source_id, kind);
  CREATE INDEX IF NOT EXISTS idx_catalog_items_episode
    ON catalog_items(parent_id, season_number, episode_number);

  CREATE TABLE IF NOT EXISTS catalog_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES library_sources(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    size INTEGER,
    mtime INTEGER,
    fingerprint TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(source_id, relative_path)
  );
  CREATE INDEX IF NOT EXISTS idx_catalog_files_item ON catalog_files(item_id);

  CREATE TABLE IF NOT EXISTS catalog_streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES catalog_files(id) ON DELETE CASCADE,
    stream_index INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('video', 'audio', 'subtitle')),
    codec TEXT,
    language TEXT,
    title TEXT,
    channels INTEGER,
    width INTEGER,
    height INTEGER,
    fps REAL,
    bitrate INTEGER,
    details TEXT,
    UNIQUE(file_id, stream_index)
  );

  CREATE TABLE IF NOT EXISTS catalog_external_ids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    item_id INTEGER NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
    UNIQUE(provider, external_id, item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_catalog_external_ids_lookup ON catalog_external_ids(provider, external_id);

  CREATE TABLE IF NOT EXISTS catalog_user_state (
    item_id INTEGER PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
    position REAL NOT NULL DEFAULT 0,
    duration REAL,
    is_finished INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS catalog_subtitles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
    managed_path TEXT NOT NULL,
    language TEXT,
    title TEXT,
    format TEXT,
    origin TEXT NOT NULL CHECK(origin IN ('sidecar', 'imported')),
    is_default INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok', 'missing', 'corrupt')),
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(item_id, managed_path)
  );

  CREATE TABLE IF NOT EXISTS catalog_metadata_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
    field TEXT NOT NULL,
    provider TEXT NOT NULL,
    value TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(item_id, field, provider)
  );
  CREATE INDEX IF NOT EXISTS idx_catalog_meta_src_item ON catalog_metadata_sources(item_id);

  CREATE TABLE IF NOT EXISTS catalog_metadata_overrides (
    item_id INTEGER PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
    patch TEXT,
    base_revision INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS scan_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES library_sources(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('queued', 'discovering', 'indexing', 'enriching', 'completed', 'cancelled', 'failed', 'interrupted')),
    cursor TEXT,
    processed_count INTEGER DEFAULT 0,
    total_count INTEGER,
    error TEXT,
    started_at INTEGER DEFAULT (unixepoch()),
    finished_at INTEGER,
    updated_at INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_scan_runs_source ON scan_runs(source_id, started_at);

  CREATE TABLE IF NOT EXISTS plugin_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 100,
    settings TEXT,
    secret_ref TEXT,
    updated_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS plugin_cache (
    plugin TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    etag TEXT,
    expiry INTEGER,
    updated_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (plugin, key)
  );
  CREATE INDEX IF NOT EXISTS idx_plugin_cache_expiry ON plugin_cache(expiry);
  `,
];

let dbInstance: Database.Database | null = null;

export function getDbPath(): string {
  const userData = app.getPath('userData');
  return join(userData, 'qy-player.db');
}

export function getDatabase(): Database.Database {
  if (!dbInstance) {
    dbInstance = openDatabaseAtPath(getDbPath());
  }
  return dbInstance;
}

/**
 * Open (and migrate) a database at an explicit path. Electron-free so it is
 * usable from integration tests; getDatabase() wraps this with the singleton.
 */
export function openDatabaseAtPath(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Required before any catalog FK (ON DELETE CASCADE) is relied on (plan §5).
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Apply pending migrations in order, each in its own transaction so a
 * mid-migration crash never leaves a half-applied schema.
 */
export function runMigrations(
  db: Database.Database,
  options: { upTo?: number } = {}
): void {
  // Create schema_version table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);

  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  const currentVersion = row?.version ?? 0;
  const target = options.upTo ?? MIGRATIONS.length;

  for (let i = currentVersion; i < target; i++) {
    const migration = MIGRATIONS[i];
    // Transactional: a mid-migration crash must not leave a half-applied schema
    db.exec(`BEGIN; ${migration}; UPDATE schema_version SET version = ${i + 1}; COMMIT;`);
  }
}

// Storage API
export interface Storage {
  // Local media
  upsertLocalMedia(media: { path: string; title?: string; duration?: number; file_size?: number }): void;
  getLocalMediaByPath(path: string): { id: number; path: string; title?: string } | undefined;

  // Progress
  saveProgress(progress: {
    mediaType: string;
    mediaId: string;
    localMediaId?: number;
    position: number;
    duration?: number;
    isFinished?: boolean;
  }): void;
  getProgress(mediaType: string, mediaId: string): { position: number; duration?: number; is_finished: number } | undefined;
  getContinueWatching(limit?: number): Array<{
    media_type: string;
    media_id: string;
    position: number;
    duration?: number;
    title?: string;
    poster_url?: string;
  }>;

  // History
  addWatchHistory(item: {
    mediaType: string;
    mediaId: string;
    title: string;
    posterUrl?: string;
    path?: string;
    position: number;
    duration?: number;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
  }): void;
  getWatchHistory(limit?: number): Array<{
    media_type: string;
    media_id: string;
    title: string;
    poster_url?: string;
    path?: string;
    position: number;
    duration?: number;
    watched_at: number;
    series_name?: string;
    season_number?: number;
    episode_number?: number;
  }>;
  clearWatchHistory(): void;
  deleteWatchHistory(mediaType: string, mediaId: string): void;

  // Servers
  saveServer(server: {
    id?: number;
    type: 'jellyfin' | 'emby';
    name: string;
    baseUrl: string;
    apiKey?: string;
    username?: string;
    userId?: string;
    isActive?: boolean;
  }): number;
  getServers(): Array<{
    id: number;
    type: string;
    name: string;
    base_url: string;
    api_key?: string;
    username?: string;
    user_id?: string;
    is_active: number;
  }>;
  deleteServer(id: number): void;

  // Config
  getConfig(key: string): string | undefined;
  setConfig(key: string, value: string): void;
}

export function createStorage(db: Database.Database): Storage {
  return {
    upsertLocalMedia(media) {
      const existing = db.prepare('SELECT id FROM local_media WHERE path = ?').get(media.path) as { id: number } | undefined;
      if (existing) {
        db.prepare(`
          UPDATE local_media SET
            title = COALESCE(?, title),
            duration = COALESCE(?, duration),
            file_size = COALESCE(?, file_size),
            last_played = unixepoch()
          WHERE id = ?
        `).run(media.title, media.duration, media.file_size, existing.id);
      } else {
        db.prepare(`
          INSERT INTO local_media (path, title, duration, file_size, last_played)
          VALUES (?, ?, ?, ?, unixepoch())
        `).run(media.path, media.title ?? null, media.duration ?? null, media.file_size ?? null);
      }
    },

    getLocalMediaByPath(path) {
      return db.prepare('SELECT id, path, title FROM local_media WHERE path = ?').get(path) as
        { id: number; path: string; title?: string } | undefined;
    },

    saveProgress(progress) {
      const existing = db.prepare(
        `SELECT id FROM playback_progress WHERE media_type = ? AND ` +
        `((media_type = 'local' AND local_media_id = ?) OR ` +
        `(media_type != 'local' AND server_id = ?))`
      ).get(progress.mediaType, progress.localMediaId ?? null, progress.mediaId) as { id: number } | undefined;

      if (existing) {
        db.prepare(`
          UPDATE playback_progress SET
            position = ?,
            duration = COALESCE(?, duration),
            is_finished = ?,
            updated_at = unixepoch()
          WHERE id = ?
        `).run(progress.position, progress.duration ?? null, progress.isFinished ? 1 : 0, existing.id);
      } else {
        db.prepare(`
          INSERT INTO playback_progress (media_type, local_media_id, server_id, position, duration, is_finished)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          progress.mediaType,
          progress.localMediaId ?? null,
          progress.mediaType === 'local' ? null : progress.mediaId,
          progress.position,
          progress.duration ?? null,
          progress.isFinished ? 1 : 0
        );
      }
    },

    getProgress(mediaType, mediaId) {
      return db.prepare(`
        SELECT position, duration, is_finished FROM playback_progress
        WHERE media_type = ? AND (
          (media_type = 'local' AND local_media_id = (SELECT id FROM local_media WHERE path = ?)) OR
          (media_type != 'local' AND server_id = ?)
        )
      `).get(mediaType, mediaId, mediaId) as
        { position: number; duration?: number; is_finished: number } | undefined;
    },

    getContinueWatching(limit = 20) {
      return db.prepare(`
        SELECT
          p.media_type,
          COALESCE(p.server_id, lm.path) as media_id,
          p.position,
          p.duration,
          h.title,
          h.poster_url
        FROM playback_progress p
        LEFT JOIN local_media lm ON p.local_media_id = lm.id
        LEFT JOIN watch_history h ON (
          h.media_type = p.media_type AND
          (h.media_id = p.server_id OR h.media_id = lm.path)
        )
        WHERE p.is_finished = 0 AND p.position > 30
        ORDER BY p.updated_at DESC
        LIMIT ?
      `).all(limit) as Array<{
        media_type: string;
        media_id: string;
        position: number;
        duration?: number;
        title?: string;
        poster_url?: string;
      }>;
    },

    addWatchHistory(item) {
      // Upsert: one row per media, update position/time on re-watch
      db.prepare(`
        INSERT INTO watch_history (media_type, media_id, title, poster_url, path, position, duration, series_name, season_number, episode_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(media_type, media_id) DO UPDATE SET
          title = excluded.title,
          poster_url = COALESCE(excluded.poster_url, poster_url),
          path = COALESCE(excluded.path, path),
          position = excluded.position,
          duration = COALESCE(excluded.duration, duration),
          series_name = COALESCE(excluded.series_name, series_name),
          season_number = COALESCE(excluded.season_number, season_number),
          episode_number = COALESCE(excluded.episode_number, episode_number),
          watched_at = unixepoch()
      `).run(
        item.mediaType,
        item.mediaId,
        item.title,
        item.posterUrl ?? null,
        item.path ?? null,
        item.position,
        item.duration ?? null,
        item.seriesName ?? null,
        item.seasonNumber ?? null,
        item.episodeNumber ?? null
      );
    },

    clearWatchHistory() {
      db.prepare('DELETE FROM watch_history').run();
      db.prepare('DELETE FROM playback_progress').run();
    },

    deleteWatchHistory(mediaType, mediaId) {
      db.prepare('DELETE FROM watch_history WHERE media_type = ? AND media_id = ?').run(mediaType, mediaId);
      if (mediaType === 'local') {
        db.prepare(`
          DELETE FROM playback_progress
          WHERE media_type = 'local'
            AND local_media_id = (SELECT id FROM local_media WHERE path = ?)
        `).run(mediaId);
      } else {
        db.prepare('DELETE FROM playback_progress WHERE media_type = ? AND server_id = ?').run(mediaType, mediaId);
      }
    },

    getWatchHistory(limit = 20) {
      return db.prepare(`
        SELECT media_type, media_id, title, poster_url, path, position, duration, watched_at, series_name, season_number, episode_number
        FROM watch_history
        ORDER BY watched_at DESC
        LIMIT ?
      `).all(limit) as Array<{
        media_type: string;
        media_id: string;
        title: string;
        poster_url?: string;
        path?: string;
        position: number;
        duration?: number;
        watched_at: number;
        series_name?: string;
        season_number?: number;
        episode_number?: number;
      }>;
    },

    saveServer(server) {
      if (server.id) {
        db.prepare(`
          UPDATE servers SET
            type = ?, name = ?, base_url = ?,
            -- api_key never receives new plaintext (SecretStore owns it);
            -- COALESCE only preserves whatever legacy value remains.
            api_key = COALESCE(?, api_key),
            username = ?, user_id = ?, is_active = ?
          WHERE id = ?
        `).run(
          server.type, server.name, server.baseUrl, null,
          server.username ?? null, server.userId ?? null, server.isActive ? 1 : 0, server.id
        );
        return server.id;
      } else {
        const result = db.prepare(`
          INSERT INTO servers (type, name, base_url, api_key, username, user_id, is_active)
          VALUES (?, ?, ?, NULL, ?, ?, ?)
        `).run(
          server.type, server.name, server.baseUrl,
          server.username ?? null, server.userId ?? null, server.isActive ? 1 : 0
        );
        return Number(result.lastInsertRowid);
      }
    },

    getServers() {
      return db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all() as Array<{
        id: number;
        type: string;
        name: string;
        base_url: string;
        api_key?: string;
        username?: string;
        user_id?: string;
        is_active: number;
      }>;
    },

    deleteServer(id) {
      db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    },

    getConfig(key) {
      const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value;
    },

    setConfig(key, value) {
      db.prepare(`
        INSERT INTO app_config (key, value, updated_at)
        VALUES (?, ?, unixepoch())
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = unixepoch()
      `).run(key, value);
    },
  };
}
