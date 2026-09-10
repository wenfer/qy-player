import type Database from 'better-sqlite3';
import type { CatalogKind, SourceKind } from '../../../shared/types';

/**
 * Parameterized data access for the phase-2 catalog schema (migration 005).
 *
 * Rules (plan §5):
 * - All statements parameterized; no string interpolation of values.
 * - Upserts must never null-out previously valid values (COALESCE pattern).
 * - DB access stays here; services and adapters never write raw SQL.
 */

export interface SourceRow {
  id: number;
  kind: SourceKind;
  name: string;
  root: string;
  secret_ref: string | null;
  read_only: number;
  options: string | null;
}

export interface CatalogItemRow {
  id: number;
  source_id: number;
  source_key: string;
  parent_id: number | null;
  kind: CatalogKind;
  title: string | null;
  year: number | null;
  season_number: number | null;
  episode_number: number | null;
  availability: 'online' | 'offline' | 'missing';
  metadata_revision: number;
  updated_at: number | null;
}

export interface CatalogFileRow {
  id: number;
  source_id: number;
  item_id: number;
  relative_path: string;
  size: number | null;
  mtime: number | null;
  fingerprint: string | null;
  updated_at: number | null;
}

export interface CatalogUserStateRow {
  item_id: number;
  position: number;
  duration: number | null;
  is_finished: number;
  updated_at: number | null;
}

export interface CatalogSubtitleRow {
  id: number;
  item_id: number;
  managed_path: string;
  language: string | null;
  title: string | null;
  format: string;
  origin: 'sidecar' | 'imported';
  is_default: number;
  status: 'ok' | 'missing' | 'corrupt';
  created_at: number | null;
}

export interface CreateSourceInput {
  kind: SourceKind;
  name: string;
  root: string;
  secretRef?: string;
  readOnly?: boolean;
  options?: Record<string, string | number | boolean>;
}

export interface UpsertItemInput {
  sourceId: number;
  sourceKey: string;
  parentId?: number | null;
  kind: CatalogKind;
  title?: string;
  year?: number;
  seasonNumber?: number;
  episodeNumber?: number;
}

export interface UpsertFileInput {
  sourceId: number;
  itemId: number;
  relativePath: string;
  size?: number;
  mtime?: number;
  fingerprint?: string;
}

export interface UpsertUserStateInput {
  itemId: number;
  position: number;
  duration?: number;
  isFinished?: boolean;
}

export interface StreamInput {
  streamIndex: number;
  kind: 'video' | 'audio' | 'subtitle';
  codec?: string;
  language?: string;
  title?: string;
  channels?: number;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  details?: Record<string, string | number | boolean>;
}

export interface StreamRow {
  id: number;
  file_id: number;
  stream_index: number;
  kind: 'video' | 'audio' | 'subtitle';
  codec: string | null;
  language: string | null;
  title: string | null;
}

export type ScanRunStatus =
  | 'queued'
  | 'discovering'
  | 'indexing'
  | 'enriching'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';

export interface ScanRunRow {
  id: number;
  source_id: number;
  status: ScanRunStatus;
  cursor: string | null;
  processed_count: number | null;
  total_count: number | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
}

export type CatalogRepository = ReturnType<typeof createCatalogRepository>;

export function createCatalogRepository(db: Database.Database) {
  return {
    // -- Sources ------------------------------------------------------------

    createSource(input: CreateSourceInput): number {
      const result = db
        .prepare(
          `INSERT INTO library_sources (kind, name, root, secret_ref, read_only, options)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.kind,
          input.name,
          input.root,
          input.secretRef ?? null,
          input.readOnly === false ? 0 : 1, // sources default to read-only (plan §14.2)
          input.options ? JSON.stringify(input.options) : null
        );
      return Number(result.lastInsertRowid);
    },

    listSources(): SourceRow[] {
      return db
        .prepare('SELECT * FROM library_sources ORDER BY id')
        .all() as SourceRow[];
    },

    getSource(id: number): SourceRow | undefined {
      return db.prepare('SELECT * FROM library_sources WHERE id = ?').get(id) as
        | SourceRow
        | undefined;
    },

    updateSource(
      id: number,
      patch: {
        name?: string;
        readOnly?: boolean;
        options?: Record<string, string | number | boolean> | null;
      }
    ): void {
      // Dynamic SET from constants only; values stay parameterized.
      const sets: string[] = [];
      const values: Array<string | number | null> = [];
      if (patch.name !== undefined) {
        sets.push('name = ?');
        values.push(patch.name);
      }
      if (patch.readOnly !== undefined) {
        sets.push('read_only = ?');
        values.push(patch.readOnly ? 1 : 0);
      }
      if (patch.options !== undefined) {
        sets.push('options = ?');
        values.push(patch.options === null ? null : JSON.stringify(patch.options));
      }
      if (sets.length === 0) return;
      sets.push('updated_at = unixepoch()');
      db
        .prepare(`UPDATE library_sources SET ${sets.join(', ')} WHERE id = ?`)
        .run(...values, id);
    },

    /** Secret refs are managed by the SecretStore layer (QYP2-005). */
    setSourceSecret(id: number, secretRef: string | null): void {
      db.prepare(
        'UPDATE library_sources SET secret_ref = ?, updated_at = unixepoch() WHERE id = ?'
      ).run(secretRef, id);
    },

    deleteSource(id: number): void {
      db.prepare('DELETE FROM library_sources WHERE id = ?').run(id);
    },

    // -- Items --------------------------------------------------------------

    /** Upsert by (source_id, source_key); metadata values never null-out. */
    upsertItem(input: UpsertItemInput): number {
      db.prepare(
        `INSERT INTO catalog_items (source_id, source_key, parent_id, kind, title, year, season_number, episode_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, source_key) DO UPDATE SET
           parent_id = COALESCE(excluded.parent_id, parent_id),
           kind = excluded.kind,
           title = COALESCE(excluded.title, title),
           year = COALESCE(excluded.year, year),
           season_number = COALESCE(excluded.season_number, season_number),
           episode_number = COALESCE(excluded.episode_number, episode_number),
           updated_at = unixepoch()`
      ).run(
        input.sourceId,
        input.sourceKey,
        input.parentId ?? null,
        input.kind,
        input.title ?? null,
        input.year ?? null,
        input.seasonNumber ?? null,
        input.episodeNumber ?? null
      );
      return this.getItemKey(input.sourceId, input.sourceKey)!.id;
    },

    getItemKey(sourceId: number, sourceKey: string): Pick<CatalogItemRow, 'id'> | undefined {
      return db
        .prepare('SELECT id FROM catalog_items WHERE source_id = ? AND source_key = ?')
        .get(sourceId, sourceKey) as Pick<CatalogItemRow, 'id'> | undefined;
    },

    getItem(id: number): CatalogItemRow | undefined {
      return db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id) as
        | CatalogItemRow
        | undefined;
    },

    // ---- Subtitle attachments (QYP2-020, catalog_subtitles) ----
    insertSubtitle(row: {
      item_id: number;
      managed_path: string;
      language: string | null;
      title: string | null;
      format: string;
      origin: 'sidecar' | 'imported';
      is_default: number;
    }): { id: number } {
      const result = db
        .prepare(
          `INSERT INTO catalog_subtitles (item_id, managed_path, language, title, format, origin, is_default, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ok')`
        )
        .run(row.item_id, row.managed_path, row.language, row.title, row.format, row.origin, row.is_default);
      return { id: Number(result.lastInsertRowid) };
    },

    /**
     * Insert + default-switch in one transaction (QYP2-020 review): a
     * plain insert followed by a separate clear could leave two defaults
     * or an orphan file if interrupted.
     */
    insertSubtitleAsDefault(row: {
      item_id: number;
      managed_path: string;
      language: string | null;
      title: string | null;
      format: string;
      origin: 'sidecar' | 'imported';
    }): { id: number } {
      const insert = db.prepare(
        `INSERT INTO catalog_subtitles (item_id, managed_path, language, title, format, origin, is_default, status)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'ok')`
      );
      const clearOthers = db.prepare(
        'UPDATE catalog_subtitles SET is_default = 0 WHERE item_id = ? AND id != ?'
      );
      const tx = db.transaction((r: typeof row): { id: number } => {
        const result = insert.run(r.item_id, r.managed_path, r.language, r.title, r.format, r.origin);
        const id = Number(result.lastInsertRowid);
        clearOthers.run(r.item_id, id);
        return { id };
      });
      return tx(row);
    },

    listSubtitlesByItem(itemId: number): CatalogSubtitleRow[] {
      return db
        .prepare('SELECT * FROM catalog_subtitles WHERE item_id = ? ORDER BY is_default DESC, id')
        .all(itemId) as CatalogSubtitleRow[];
    },

    getSubtitle(itemId: number, rowId: number): CatalogSubtitleRow | undefined {
      return db
        .prepare('SELECT * FROM catalog_subtitles WHERE item_id = ? AND id = ?')
        .get(itemId, rowId) as CatalogSubtitleRow | undefined;
    },

    deleteSubtitle(itemId: number, rowId: number): void {
      db.prepare('DELETE FROM catalog_subtitles WHERE item_id = ? AND id = ?').run(itemId, rowId);
    },

    /** Unset every default flag for the item except (optionally) one row. */
    clearDefaultSubtitles(itemId: number, exceptId?: number): void {
      if (exceptId !== undefined) {
        db.prepare('UPDATE catalog_subtitles SET is_default = 0 WHERE item_id = ? AND id != ?').run(itemId, exceptId);
      } else {
        db.prepare('UPDATE catalog_subtitles SET is_default = 0 WHERE item_id = ?').run(itemId);
      }
    },

    /** Promote one row to default and demote the rest (atomic). */
    setDefaultSubtitle(itemId: number, rowId: number): void {
      const demote = db.prepare('UPDATE catalog_subtitles SET is_default = 0 WHERE item_id = ?');
      const promote = db.prepare('UPDATE catalog_subtitles SET is_default = 1 WHERE item_id = ? AND id = ?');
      db.transaction(() => {
        demote.run(itemId);
        promote.run(itemId, rowId);
      })();
    },

    /** Every subtitle path in the DB (for orphan sweeps across items). */
    listAllSubtitlePaths(): string[] {
      return (
        db.prepare('SELECT managed_path FROM catalog_subtitles') as { all(): Array<{ managed_path: string }> }
      )
        .all()
        .map((r) => r.managed_path);
    },

    updateSubtitleStatus(itemId: number, rowId: number, status: 'ok' | 'missing' | 'corrupt'): void {
      db.prepare('UPDATE catalog_subtitles SET status = ? WHERE item_id = ? AND id = ?').run(status, itemId, rowId);
    },

    listItemsBySource(sourceId: number): CatalogItemRow[] {
      return db
        .prepare('SELECT * FROM catalog_items WHERE source_id = ? ORDER BY id')
        .all(sourceId) as CatalogItemRow[];
    },

    listByParent(parentId: number | null, sourceId?: number): CatalogItemRow[] {
      if (sourceId !== undefined) {
        return db
          .prepare(
            'SELECT * FROM catalog_items WHERE parent_id IS ? AND source_id = ? ORDER BY id'
          )
          .all(parentId, sourceId) as CatalogItemRow[];
      }
      return db
        .prepare('SELECT * FROM catalog_items WHERE parent_id IS ? ORDER BY id')
        .all(parentId) as CatalogItemRow[];
    },

    /**
     * Availability may only be downgraded after a *successful full scan*
     * (plan §6.1). Bulk variant keeps the online/missing pass atomic so a
     * crash cannot leave the catalog half-updated.
     */
    setAvailabilityBulk(
      patches: Array<{ id: number; availability: 'online' | 'offline' | 'missing' }>
    ): void {
      const update = db.prepare(
        'UPDATE catalog_items SET availability = ?, updated_at = unixepoch() WHERE id = ?'
      );
      db.transaction((rows: Array<{ id: number; availability: 'online' | 'offline' | 'missing' }>) => {
        for (const row of rows) update.run(row.availability, row.id);
      })(patches);
    },

    /** Availability may only be downgraded after a *successful full scan*. */
    setAvailability(
      id: number,
      availability: 'online' | 'offline' | 'missing'
    ): void {
      db.prepare(
        'UPDATE catalog_items SET availability = ?, updated_at = unixepoch() WHERE id = ?'
      ).run(availability, id);
    },

    // -- Files --------------------------------------------------------------

    upsertFile(input: UpsertFileInput): number {
      db.prepare(
        `INSERT INTO catalog_files (source_id, item_id, relative_path, size, mtime, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, relative_path) DO UPDATE SET
           item_id = excluded.item_id,
           size = COALESCE(excluded.size, size),
           mtime = COALESCE(excluded.mtime, mtime),
           fingerprint = COALESCE(excluded.fingerprint, fingerprint),
           updated_at = unixepoch()`
      ).run(
        input.sourceId,
        input.itemId,
        input.relativePath,
        input.size ?? null,
        input.mtime ?? null,
        input.fingerprint ?? null
      );
      const row = db
        .prepare('SELECT id FROM catalog_files WHERE source_id = ? AND relative_path = ?')
        .get(input.sourceId, input.relativePath) as { id: number };
      return row.id;
    },

    getFileByPath(sourceId: number, relativePath: string): CatalogFileRow | undefined {
      return db
        .prepare('SELECT * FROM catalog_files WHERE source_id = ? AND relative_path = ?')
        .get(sourceId, relativePath) as CatalogFileRow | undefined;
    },

    listFilesByItem(itemId: number): CatalogFileRow[] {
      return db
        .prepare('SELECT * FROM catalog_files WHERE item_id = ? ORDER BY relative_path')
        .all(itemId) as CatalogFileRow[];
    },

    listFilesBySource(sourceId: number): CatalogFileRow[] {
      return db
        .prepare('SELECT * FROM catalog_files WHERE source_id = ? ORDER BY relative_path')
        .all(sourceId) as CatalogFileRow[];
    },

    // -- Streams ------------------------------------------------------------

    /** Replace the stream set of a file atomically (probe result is authoritative). */
    replaceStreams(fileId: number, streams: StreamInput[]): void {
      const insert = db.prepare(
        `INSERT INTO catalog_streams
           (file_id, stream_index, kind, codec, language, title, channels, width, height, fps, bitrate, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM catalog_streams WHERE file_id = ?').run(fileId);
        for (const s of streams) {
          insert.run(
            fileId,
            s.streamIndex,
            s.kind,
            s.codec ?? null,
            s.language ?? null,
            s.title ?? null,
            s.channels ?? null,
            s.width ?? null,
            s.height ?? null,
            s.fps ?? null,
            s.bitrate ?? null,
            s.details ? JSON.stringify(s.details) : null
          );
        }
      });
      tx();
    },

    // -- User state ----------------------------------------------------------

    /** Upsert; a missing duration never clears a previous valid one. */
    upsertUserState(input: UpsertUserStateInput): void {
      db.prepare(
        `INSERT INTO catalog_user_state (item_id, position, duration, is_finished)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           position = excluded.position,
           duration = COALESCE(excluded.duration, duration),
           is_finished = excluded.is_finished,
           updated_at = unixepoch()`
      ).run(
        input.itemId,
        input.position,
        input.duration ?? null,
        input.isFinished ? 1 : 0
      );
    },

    getUserState(itemId: number): CatalogUserStateRow | undefined {
      return db
        .prepare('SELECT * FROM catalog_user_state WHERE item_id = ?')
        .get(itemId) as CatalogUserStateRow | undefined;
    },

    // -- External ids ---------------------------------------------------------

    upsertExternalId(provider: string, externalId: string, itemId: number): void {
      db.prepare(
        `INSERT INTO catalog_external_ids (provider, external_id, item_id)
         VALUES (?, ?, ?)
         ON CONFLICT(provider, external_id, item_id) DO NOTHING`
      ).run(provider, externalId, itemId);
    },

    findItemIdByExternalId(provider: string, externalId: string): number | undefined {
      const row = db
        .prepare('SELECT item_id FROM catalog_external_ids WHERE provider = ? AND external_id = ?')
        .get(provider, externalId) as { item_id: number } | undefined;
      return row?.item_id;
    },

    // -- Metadata sources (plan §9.2: per-field provider provenance) --------

    /**
     * Upsert one (item, field, provider) slot. Values are JSON-encoded so
     * scalars, arrays and actor lists round-trip uniformly.
     */
    upsertMetadataSource(itemId: number, field: string, provider: string, value: unknown): void {
      db.prepare(
        `INSERT INTO catalog_metadata_sources (item_id, field, provider, value, revision, updated_at)
         VALUES (?, ?, ?, ?, 1, unixepoch())
         ON CONFLICT(item_id, field, provider) DO UPDATE SET
           value = excluded.value,
           revision = revision + 1,
           updated_at = unixepoch()`
      ).run(itemId, field, provider, JSON.stringify(value));
    },

    deleteMetadataSource(itemId: number, field: string, provider: string): void {
      db.prepare('DELETE FROM catalog_metadata_sources WHERE item_id = ? AND field = ? AND provider = ?')
        .run(itemId, field, provider);
    },

    listMetadataSources(itemId: number): Array<{
      field: string;
      provider: string;
      value: string | null;
      revision: number;
      updated_at: number | null;
    }> {
      return db
        .prepare(
          'SELECT field, provider, value, revision, updated_at FROM catalog_metadata_sources WHERE item_id = ?'
        )
        .all(itemId) as Array<{
        field: string;
        provider: string;
        value: string | null;
        revision: number;
        updated_at: number | null;
      }>;
    },

    /** Metadata rows for many items in one query (list overlay). */
    listMetadataSourcesForItems(itemIds: number[]): Array<{
      item_id: number;
      field: string;
      provider: string;
      value: string | null;
      revision: number;
    }> {
      if (itemIds.length === 0) return [];
      const placeholders = itemIds.map(() => '?').join(', ');
      return db
        .prepare(
          `SELECT item_id, field, provider, value, revision
           FROM catalog_metadata_sources WHERE item_id IN (${placeholders})`
        )
        .all(...itemIds) as Array<{
        item_id: number;
        field: string;
        provider: string;
        value: string | null;
        revision: number;
      }>;
    },

    /**
     * Filtered, paginated item listing (browse/search share this).
     * `search` matches item titles with LIKE (input pre-escaped by caller).
     */
    listItemsFiltered(
      filter: {
        sourceId: number;
        parentId?: number | null;
        kind?: CatalogKind;
        search?: string;
      },
      limit: number,
      offset: number
    ): { rows: CatalogItemRow[]; total: number } {
      const where: string[] = ['source_id = ?'];
      const values: Array<string | number> = [filter.sourceId];
      if (filter.parentId === null) {
        where.push('parent_id IS NULL');
      } else if (filter.parentId !== undefined) {
        where.push('parent_id = ?');
        values.push(filter.parentId);
      }
      if (filter.kind) {
        where.push('kind = ?');
        values.push(filter.kind);
      }
      if (filter.search) {
        // Titles plus metadata winners (NFO title/originalTitle/sortTitle).
        where.push(
          `(title LIKE ? ESCAPE '\\' OR id IN (
             SELECT item_id FROM catalog_metadata_sources
             WHERE field IN ('title', 'originalTitle', 'sortTitle') AND value LIKE ? ESCAPE '\\'
           ))`
        );
        values.push(filter.search, filter.search);
      }
      const whereSql = where.join(' AND ');
      // Episodes sort by season/episode; everything else by title (NOCASE).
      const orderSql =
        filter.kind === 'episode'
          ? 'season_number, episode_number, title COLLATE NOCASE'
          : 'title COLLATE NOCASE, season_number, episode_number';
      const rows = db
        .prepare(`SELECT * FROM catalog_items WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
        .all(...values, limit, offset) as CatalogItemRow[];
      const total = (
        db.prepare(`SELECT COUNT(*) AS n FROM catalog_items WHERE ${whereSql}`).get(...values) as { n: number }
      ).n;
      return { rows, total };
    },

    /** User states for many items (progress display on cards). */
    listUserStatesForItems(itemIds: number[]): CatalogUserStateRow[] {
      if (itemIds.length === 0) return [];
      const placeholders = itemIds.map(() => '?').join(', ');
      return db
        .prepare(`SELECT item_id, position, duration, is_finished, updated_at FROM catalog_user_state WHERE item_id IN (${placeholders})`)
        .all(...itemIds) as CatalogUserStateRow[];
    },

    // -- Scan runs -----------------------------------------------------------

    createScanRun(sourceId: number): number {
      const result = db
        .prepare("INSERT INTO scan_runs (source_id, status) VALUES (?, 'queued')")
        .run(sourceId);
      return Number(result.lastInsertRowid);
    },

    updateScanRun(
      id: number,
      patch: {
        status?: ScanRunStatus;
        cursor?: string | null;
        processedCount?: number;
        totalCount?: number | null;
        error?: string | null;
        finishedAt?: number | null;
      }
    ): void {
      const sets: string[] = [];
      const values: Array<string | number | null> = [];
      if (patch.status !== undefined) {
        sets.push('status = ?');
        values.push(patch.status);
      }
      if (patch.cursor !== undefined) {
        sets.push('cursor = ?');
        values.push(patch.cursor);
      }
      if (patch.processedCount !== undefined) {
        sets.push('processed_count = ?');
        values.push(patch.processedCount);
      }
      if (patch.totalCount !== undefined) {
        sets.push('total_count = ?');
        values.push(patch.totalCount);
      }
      if (patch.error !== undefined) {
        sets.push('error = ?');
        values.push(patch.error);
      }
      if (patch.finishedAt !== undefined) {
        sets.push('finished_at = ?');
        values.push(patch.finishedAt);
      }
      if (sets.length === 0) return;
      sets.push('updated_at = unixepoch()');
      db.prepare(`UPDATE scan_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    },

    getScanRun(id: number): ScanRunRow | undefined {
      return db.prepare('SELECT * FROM scan_runs WHERE id = ?').get(id) as ScanRunRow | undefined;
    },

    /** Most recent run of a source (for list views); undefined when never scanned. */
    getLatestScanRun(sourceId: number): ScanRunRow | undefined {
      return db
        .prepare('SELECT * FROM scan_runs WHERE source_id = ? ORDER BY started_at DESC, id DESC LIMIT 1')
        .get(sourceId) as ScanRunRow | undefined;
    },

    /** Startup recovery: anything non-terminal becomes interrupted (plan §6.1). */
    recoverInterruptedScanRuns(): number {
      const result = db
        .prepare(
          `UPDATE scan_runs
           SET status = 'interrupted', finished_at = unixepoch(), updated_at = unixepoch()
           WHERE status IN ('queued', 'discovering', 'indexing', 'enriching')`
        )
        .run();
      return result.changes;
    },
  };
}
