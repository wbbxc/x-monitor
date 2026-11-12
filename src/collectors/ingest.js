// 入库层：一页一个事务，内容与游标同时提交，失败整页回滚。
import { collectionCursors, collectionItems, transaction } from '../db.js';
import { normalizeCollectionItem } from './normalize.js';

export function createIngestor({
  sourceId = null, ruleId = null, runId = null, adapterId = null,
  matches = null, onItemSaved = null, onFiltered = null,
} = {}) {
  return {
    /** @returns {{collected:number, added:number, updated:number, incomplete:number, filtered:number}} */
    ingestPage(items = [], { cursor } = {}) {
      return transaction(() => {
        const counts = { collected: 0, added: 0, updated: 0, incomplete: 0, filtered: 0 };
        for (const raw of items) {
          const normalized = normalizeCollectionItem(raw);
          counts.collected++;
          if (typeof matches === 'function' && !matches(normalized)) {
            counts.filtered++;
            onFiltered?.({ item: normalized });
            continue;
          }
          const saved = collectionItems.upsert(normalized, { sourceId, ruleId, runId });
          if (saved.isNew) counts.added++;
          else counts.updated++;
          if (!saved.item.required_complete) counts.incomplete++;
          onItemSaved?.({ item: saved.item, saved, normalized });
        }
        if (cursor !== undefined && sourceId != null && adapterId) {
          if (cursor == null) collectionCursors.clear(sourceId, adapterId);
          else collectionCursors.set(sourceId, adapterId, cursor);
        }
        return counts;
      });
    },

    clearCursor() {
      if (sourceId != null && adapterId) collectionCursors.clear(sourceId, adapterId);
    },

    setCursor(cursor) {
      if (sourceId == null || !adapterId) return;
      if (cursor == null) collectionCursors.clear(sourceId, adapterId);
      else collectionCursors.set(sourceId, adapterId, cursor);
    },

    getCursor() {
      if (sourceId == null || !adapterId) return null;
      return collectionCursors.get(sourceId, adapterId);
    },
  };
}
