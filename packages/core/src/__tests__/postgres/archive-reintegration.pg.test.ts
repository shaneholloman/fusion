import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { reconcileArchivedTasksIntoDonePass, reintegrateArchivedTasksIntoDoneOnOpen } from "../../task-store/archive-reintegration.js";
import {
  findArchivedTaskEntry,
  upsertArchivedTaskEntry,
} from "../../task-store/async/async-archive-lineage.js";
import { projectPartition } from "../../task-store/async/async-lifecycle.js";

pgDescribe("archived task startup reintegration", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_archive_reintegration",
    projectId: "project-archive-reintegration",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("restores cold snapshots into Done and drains the archive row", async () => {
    const store = h.store();
    const task = await store.createTaskWithReservedId(
      { description: "legacy archived delivery", column: "done" },
      { taskId: "FN-29501", applyDefaultWorkflowSteps: false },
    );
    const archivedAt = "2026-08-30T12:00:00.000Z";
    const entry = await store.taskToArchiveEntry(task, archivedAt);

    await upsertArchivedTaskEntry(h.layer().db, entry, h.layer().projectId);
    await h.layer().db
      .update(schema.project.tasks)
      .set({ column: "archived", deletedAt: archivedAt, updatedAt: archivedAt })
      .where(and(
        eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
        eq(schema.project.tasks.id, task.id),
      ));

    await expect(reintegrateArchivedTasksIntoDoneOnOpen(store)).resolves.toBe(1);

    const restored = await store.getTask(task.id);
    expect(restored.column).toBe("done");
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.log.at(-1)?.action).toBe("Archived task reintegrated into Done");
    await expect(findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).resolves.toBeUndefined();
    await expect(store.listTasks({ includeArchived: false })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: task.id, column: "done" })]),
    );
  });

  it("recreates a cold snapshot whose project row was physically removed", async () => {
    const store = h.store();
    const task = await store.createTaskWithReservedId(
      { description: "cold-only legacy delivery", column: "done" },
      { taskId: "FN-29504", applyDefaultWorkflowSteps: false },
    );
    const archivedAt = "2026-08-30T12:30:00.000Z";
    const entry = await store.taskToArchiveEntry(task, archivedAt);
    await h.layer().db
      .delete(schema.project.tasks)
      .where(and(
        eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
        eq(schema.project.tasks.id, task.id),
      ));
    await upsertArchivedTaskEntry(h.layer().db, entry, h.layer().projectId);
    await expect(h.layer().db
      .select({ id: schema.project.tasks.id })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id))).resolves.toEqual([]);

    await expect(findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).resolves.toMatchObject({ id: task.id });
    const result = await reconcileArchivedTasksIntoDonePass(store);
    expect(result).toMatchObject({ restoredCount: 1, outcomes: [{ taskId: task.id, outcome: "restored" }] });

    await expect(store.getTask(task.id)).resolves.toMatchObject({
      id: task.id,
      column: "done",
      description: task.description,
    });
    await expect(findArchivedTaskEntry(h.layer().db, task.id, h.layer().projectId)).resolves.toBeUndefined();
  });

  it("repairs a live archived sentinel without resurrecting soft-deleted tasks", async () => {
    const store = h.store();
    const stranded = await store.createTaskWithReservedId(
      { description: "stranded restore", column: "done" },
      { taskId: "FN-29502", applyDefaultWorkflowSteps: false },
    );
    const deleted = await store.createTaskWithReservedId(
      { description: "intentional deletion", column: "done" },
      { taskId: "FN-29503", applyDefaultWorkflowSteps: false },
    );
    const now = "2026-08-30T13:00:00.000Z";
    await h.layer().db
      .update(schema.project.tasks)
      .set({ column: "archived", updatedAt: now })
      .where(and(
        eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
        eq(schema.project.tasks.id, stranded.id),
      ));
    await h.layer().db
      .update(schema.project.tasks)
      .set({ column: "archived", deletedAt: now, updatedAt: now })
      .where(and(
        eq(schema.project.tasks.projectId, projectPartition(h.layer().projectId)),
        eq(schema.project.tasks.id, deleted.id),
      ));

    await expect(reintegrateArchivedTasksIntoDoneOnOpen(store)).resolves.toBe(1);
    await expect(store.getTask(stranded.id)).resolves.toEqual(expect.objectContaining({ column: "done" }));
    await expect(store.getTask(deleted.id)).rejects.toThrow();
  });
});
