/**
 * Cleanup manifest for synthetic E2E test data.
 *
 * Tracks every synthetic database entity created during a test run
 * and provides safe, targeted cleanup that only deletes manifest-owned IDs.
 *
 * Issue #728 safety gate 4:
 * - Never delete by broad date/email prefix alone
 * - Cleanup deletes only exact manifest-owned IDs after verifying ownership
 * - Dry-run/preview first
 * - Verify zero synthetic rows after execution
 * - Fail closed for missing proof
 */

// ── Types ──

export interface ManifestEntry {
  table: string;
  id: string;
  /** Column name for the primary key (default: 'id') */
  pkColumn: string;
  /** Additional identifying info for verification */
  meta: Record<string, unknown>;
  createdAt: string;
  /** Related entries that depend on this one (cascade order) */
  dependents: Array<{ table: string; id: string; pkColumn: string }>;
}

export interface CleanupManifest {
  runId: string;
  createdAt: string;
  entries: ManifestEntry[];
}

export interface CleanupResult {
  runId: string;
  mode: 'dry-run' | 'execute';
  planned: number;
  deleted: number;
  failed: Array<{ table: string; id: string; error: string }>;
  verified: boolean;
  remainingSyntheticRows: number;
}

// ── Manifest ──

export class CleanupTracker {
  private manifest: CleanupManifest;

  constructor(runId: string) {
    this.manifest = {
      runId,
      createdAt: new Date().toISOString(),
      entries: [],
    };
  }

  /**
   * Record a created entity for later cleanup.
   */
  track(entry: Omit<ManifestEntry, 'createdAt' | 'dependents'>): void {
    this.manifest.entries.push({
      ...entry,
      createdAt: new Date().toISOString(),
      dependents: [],
    });
  }

  /**
   * Record a dependent entity (e.g., bot_sessions created by a business).
   */
  trackDependent(parentTable: string, parentId: string, dependent: {
    table: string;
    id: string;
    pkColumn?: string;
  }): void {
    const parent = this.manifest.entries.find(
      e => e.table === parentTable && e.id === parentId
    );
    if (parent) {
      parent.dependents.push({
        table: dependent.table,
        id: dependent.id,
        pkColumn: dependent.pkColumn || 'id',
      });
    } else {
      // Track as independent if parent not found
      this.track({
        table: dependent.table,
        id: dependent.id,
        pkColumn: dependent.pkColumn || 'id',
        meta: { orphanedParent: `${parentTable}:${parentId}` },
      });
    }
  }

  /**
   * Get the full manifest for serialization.
   */
  getManifest(): CleanupManifest {
    return { ...this.manifest };
  }

  /**
   * Get deletion order: dependents first, then parents (reverse creation order).
   */
  getDeletionOrder(): Array<{ table: string; id: string; pkColumn: string }> {
    const order: Array<{ table: string; id: string; pkColumn: string }> = [];

    // Process in reverse creation order
    for (let i = this.manifest.entries.length - 1; i >= 0; i--) {
      const entry = this.manifest.entries[i];
      // Dependents first
      for (const dep of entry.dependents) {
        order.push(dep);
      }
      // Then the parent
      order.push({ table: entry.table, id: entry.id, pkColumn: entry.pkColumn });
    }

    // Deduplicate (same entity might be tracked as both dependent and independent)
    const seen = new Set<string>();
    return order.filter(item => {
      const key = `${item.table}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Generate a dry-run preview of what would be deleted.
   */
  previewCleanup(): CleanupResult {
    const deletionOrder = this.getDeletionOrder();
    return {
      runId: this.manifest.runId,
      mode: 'dry-run',
      planned: deletionOrder.length,
      deleted: 0,
      failed: [],
      verified: false,
      remainingSyntheticRows: -1, // Unknown in dry-run without DB
    };
  }

  /**
   * Serialize the manifest to JSON for persistence.
   */
  toJSON(): string {
    return JSON.stringify(this.manifest, null, 2);
  }

  /**
   * Restore a manifest from JSON.
   */
  static fromJSON(json: string): CleanupTracker {
    const data = JSON.parse(json) as CleanupManifest;
    const tracker = new CleanupTracker(data.runId);
    tracker.manifest = data;
    return tracker;
  }
}
