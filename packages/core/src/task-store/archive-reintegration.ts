import type { TaskStore } from "../store.js";
import { createLogger } from "../process/logger.js";
import type { Column } from "../types.js";
import { listArchivedTaskEntriesPage } from "../async-stores/async-archive-db.js";
import { restoreTaskFromArchive } from "./async/async-archive-lineage.js";
import { resolveWorkflowIrForTask } from "../workflows/workflow-ir-resolver.js";
import { resolveCompleteColumn } from "../workflows/workflow-lifecycle-traits.js";
import { readTaskRow } from "./async/async-persistence.js";

export const ARCHIVE_REINTEGRATION_PAGE_SIZE = 200;
const DEFAULT_ARCHIVE_REINTEGRATION_MAX_FAILURE_ATTEMPTS = 3;
const archiveReintegrationLog = createLogger("core-archive-reintegration");

interface ArchivedTaskReintegrationCursor {
  liveOffset: number;
  coldOffset: number;
  singleSource: ArchivedTaskReintegrationSource;
  failureAttempts: Map<string, number>;
}

const archiveReintegrationCursors = new WeakMap<TaskStore, ArchivedTaskReintegrationCursor>();

function getArchiveReintegrationCursor(store: TaskStore): ArchivedTaskReintegrationCursor {
  const existing = archiveReintegrationCursors.get(store);
  if (existing) return existing;
  const created: ArchivedTaskReintegrationCursor = {
    liveOffset: 0,
    coldOffset: 0,
    singleSource: "live-column",
    failureAttempts: new Map(),
  };
  archiveReintegrationCursors.set(store, created);
  return created;
}

async function readCursorPage<T>(
  offset: number,
  limit: number,
  readPage: (offset: number, limit: number) => Promise<T[]>,
): Promise<{ items: T[]; offset: number }> {
  if (limit <= 0) return { items: [], offset };
  const items = await readPage(offset, limit);
  if (items.length > 0 || offset === 0) return { items, offset };
  return { items: await readPage(0, limit), offset: 0 };
}

function shouldAttemptReintegration(
  cursor: ArchivedTaskReintegrationCursor,
  key: string,
  maxFailureAttempts: number,
): boolean {
  const attempts = cursor.failureAttempts.get(key) ?? 0;
  if (attempts < maxFailureAttempts) return true;
  // One traversal is deliberately yielded after the shared starvation budget is exhausted. A later
  // traversal retries in case the failure was transient, while the cursor continues past this row.
  cursor.failureAttempts.delete(key);
  return false;
}

export type ArchivedTaskReintegrationSource = "live-column" | "cold-storage";
export type ArchivedTaskReintegrationOutcome = "moved" | "restored" | "live-won" | "failed";

export interface ArchivedTaskReintegrationItem {
  taskId: string;
  source: ArchivedTaskReintegrationSource;
  outcome: ArchivedTaskReintegrationOutcome;
}

export interface ArchivedTaskReintegrationResult {
  movedCount: number;
  restoredCount: number;
  outcomes: ArchivedTaskReintegrationItem[];
  hasMore: boolean;
}

async function resolveDoneColumn(store: TaskStore, taskId: string): Promise<Column> {
  try {
    const workflow = await resolveWorkflowIrForTask(store, taskId);
    return (resolveCompleteColumn(workflow) ?? "done") as Column;
  } catch {
    return "done" as Column;
  }
}

async function mirrorReintegratedTask(store: TaskStore, taskId: string): Promise<void> {
  await store.logEntry(taskId, "Archived task reintegrated into Done");
  const task = await store.getTask(taskId);
  await store.atomicWriteTaskJson(store.taskDir(taskId), task);
}

/**
 * Reintegrate one bounded page of historical archive state into workflow completion lanes.
 *
 * FNXC:TaskArchiveRemoval 2026-09-04-19:28:
 * Self-healing repeatedly calls this bounded pass. Live `archived` rows move through the normal
 * engine recovery path, preserving task progress and attachments. Cold snapshots restore under a
 * project/task advisory transaction; a concurrent or pre-existing live row wins and the duplicate
 * snapshot is drained without replacing that row. User-paused rows are never mutated.
 *
 * FNXC:TaskArchiveRemoval 2026-09-04-20:10:
 * Live and cold sources receive independent shares of every pass, and each source retains a cursor
 * across maintenance cycles. Paused or repeatedly failing rows therefore consume neither every live
 * page nor the cold-storage opportunity forever. Failed rows yield after the caller's shared
 * starvation budget, then retry on a later traversal so transient repairs remain recoverable.
 */
export async function reconcileArchivedTasksIntoDonePass(
  store: TaskStore,
  options: { limit?: number; maxFailureAttempts?: number } = {},
): Promise<ArchivedTaskReintegrationResult> {
  const layer = store.asyncLayer;
  if (!layer) throw new Error("Archived task reintegration requires the async task backend");
  const limit = Math.min(500, Math.max(1, Math.trunc(options.limit ?? ARCHIVE_REINTEGRATION_PAGE_SIZE) || ARCHIVE_REINTEGRATION_PAGE_SIZE));
  const maxFailureAttempts = Math.max(1, Math.trunc(options.maxFailureAttempts ?? DEFAULT_ARCHIVE_REINTEGRATION_MAX_FAILURE_ATTEMPTS) || DEFAULT_ARCHIVE_REINTEGRATION_MAX_FAILURE_ATTEMPTS);
  const cursor = getArchiveReintegrationCursor(store);
  let liveLimit = Math.ceil(limit / 2);
  let coldLimit = limit - liveLimit;
  if (limit === 1) {
    liveLimit = cursor.singleSource === "live-column" ? 1 : 0;
    coldLimit = cursor.singleSource === "cold-storage" ? 1 : 0;
    cursor.singleSource = cursor.singleSource === "live-column" ? "cold-storage" : "live-column";
  }
  const outcomes: ArchivedTaskReintegrationItem[] = [];
  let movedCount = 0;
  let restoredCount = 0;

  const livePage = await readCursorPage(cursor.liveOffset, liveLimit, async (offset, pageLimit) => await store.listTasks({
    column: "archived",
    includeArchived: false,
    includeDeleted: false,
    limit: pageLimit,
    offset,
    slim: false,
    startupMemo: false,
  }));
  let liveSurvivors = 0;

  for (const task of livePage.items) {
    const failureKey = `live:${task.id}`;
    if (task.userPaused || !shouldAttemptReintegration(cursor, failureKey, maxFailureAttempts)) {
      liveSurvivors += 1;
      continue;
    }
    let leftArchivedColumn = false;
    try {
      const doneColumn = await resolveDoneColumn(store, task.id);
      const moved = await store.moveTaskIf(
        task.id,
        doneColumn,
        (live) => live.column === "archived" && !live.userPaused,
        { moveSource: "engine", recoveryRehome: true, preserveProgress: true },
      );
      if (!moved.moved) {
        if (moved.task?.column === "archived") liveSurvivors += 1;
        continue;
      }
      leftArchivedColumn = true;
      await mirrorReintegratedTask(store, task.id);
      cursor.failureAttempts.delete(failureKey);
      movedCount += 1;
      outcomes.push({ taskId: task.id, source: "live-column", outcome: "moved" });
    } catch (error) {
      if (!leftArchivedColumn) liveSurvivors += 1;
      cursor.failureAttempts.set(failureKey, (cursor.failureAttempts.get(failureKey) ?? 0) + 1);
      outcomes.push({ taskId: task.id, source: "live-column", outcome: "failed" });
      archiveReintegrationLog.warn("Live archived task reintegration failed", {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  cursor.liveOffset = livePage.offset + liveSurvivors;

  const coldPage = await readCursorPage(cursor.coldOffset, coldLimit, async (offset, pageLimit) =>
    await listArchivedTaskEntriesPage(layer.db, pageLimit, offset, layer.projectId));
  let coldSurvivors = 0;
  for (const entry of coldPage.items) {
    const failureKey = `cold:${entry.id}`;
    if (!shouldAttemptReintegration(cursor, failureKey, maxFailureAttempts)) {
      coldSurvivors += 1;
      continue;
    }
    let drainedColdSnapshot = false;
    try {
      /*
      FNXC:TaskArchiveRemoval 2026-09-04-19:28:
      Read the authoritative row directly: TaskStore.getTask may still cache a row that a legacy
      cleanup physically removed before the cold snapshot was published.
      */
      const existingRow = await readTaskRow(layer, entry.id, { includeDeleted: true });
      if (existingRow?.userPaused === true) {
        coldSurvivors += 1;
        continue;
      }
      const doneColumn = await resolveDoneColumn(store, entry.id);
      const now = entry.executionCompletedAt ?? entry.columnMovedAt ?? entry.archivedAt;
      const taskRecord = existingRow && !existingRow.deletedAt
        ? undefined
        : { ...store.archiveEntryToTask(entry), column: doneColumn, columnMovedAt: now, updatedAt: now };
      const restoration = await restoreTaskFromArchive(layer, entry, {
        targetColumn: doneColumn,
        now,
        ...(taskRecord ? { taskRecord } : {}),
      });
      if (restoration.outcome === "user-paused") {
        coldSurvivors += 1;
        continue;
      }
      drainedColdSnapshot = true;
      if (restoration.outcome === "restored") {
        await store.restoreFromArchive(entry, { targetColumn: doneColumn, now });
      }
      await mirrorReintegratedTask(store, entry.id);
      cursor.failureAttempts.delete(failureKey);
      if (restoration.outcome === "restored") restoredCount += 1;
      outcomes.push({
        taskId: entry.id,
        source: "cold-storage",
        outcome: restoration.outcome,
      });
    } catch (error) {
      if (!drainedColdSnapshot) coldSurvivors += 1;
      cursor.failureAttempts.set(failureKey, (cursor.failureAttempts.get(failureKey) ?? 0) + 1);
      outcomes.push({ taskId: entry.id, source: "cold-storage", outcome: "failed" });
      archiveReintegrationLog.warn("Archived cold snapshot reintegration failed", {
        taskId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  cursor.coldOffset = coldPage.offset + coldSurvivors;

  return {
    movedCount,
    restoredCount,
    outcomes,
    hasMore: cursor.liveOffset > 0
      || cursor.coldOffset > 0
      || (liveLimit > 0 && livePage.items.length >= liveLimit)
      || (coldLimit > 0 && coldPage.items.length >= coldLimit),
  };
}

/**
 * Store-open compatibility pass for hosts that do not run the engine. The engine owns repeated
 * startup/maintenance reconciliation; opening a store performs only one bounded page.
 */
export async function reintegrateArchivedTasksIntoDoneOnOpen(store: TaskStore): Promise<number> {
  const result = await reconcileArchivedTasksIntoDonePass(store);
  return result.movedCount + result.restoredCount;
}
