/**
 * FNXC:CodeOrganization 2026-08-10-03:45:
 * The ghost-bug cleanup helper was peeled from self-healing.ts (U5 / wave19 Slice A).
 */
import type { TaskStore } from "@fusion/core";
import type { GhostBugDecision } from "../triage-domain/triage-preflight.js";

/**
 * Soft-delete a task whose cited construct is not present on main (ghost bug).
 *
 * FNXC:TaskArchiveRemoval 2026-09-04-10:36:
 * Ghost work is not completed work. Preserve its reserved identity with a non-resurrectable
 * soft-delete instead of moving it to a removed archive lane.
 */
export async function softDeleteAsGhostBug(
  store: TaskStore,
  taskId: string,
  decision: GhostBugDecision,
): Promise<void> {
  await store.logEntry(
    taskId,
    "Auto-deleted as ghost bug — cited code construct not present on main",
    JSON.stringify({ reason: decision.reason, findings: decision.findings }, null, 2),
  );
  await store.deleteTask(taskId, { allowResurrection: false });
}
