import { describe, expect, it, vi } from "vitest";
import { archiveTerminalWorkflowStepFailures, getLatestFailedPreMergeReviewStep, type Task, type WorkflowStepResult } from "@fusion/core";
import { clearTerminalStepFailuresForRetry } from "../executor/clear-terminal-step-failures-for-retry.js";

/*
FNXC:ReviewRemediation 2026-09-05-22:31:
FN-295 root cause: a Code Review remediation archived EVERY terminal failure, including a stale Plan
Review row from nine hours earlier. An archived carrier is an unconditional merge veto no recovery can
select, so the card became permanently unmergeable. The remediation archive must cover only the gate it
is remediating.
*/

const result = (overrides: Partial<WorkflowStepResult>): WorkflowStepResult => ({
  workflowStepId: "code-review",
  workflowStepName: "Code Review",
  phase: "pre-merge",
  status: "failed",
  startedAt: "2026-09-04T19:27:00.000Z",
  completedAt: "2026-09-04T19:28:37.000Z",
  ...overrides,
});

const stalePlanReview = result({
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  reviewKind: "plan",
  startedAt: "2026-09-04T10:10:44.000Z",
  completedAt: "2026-09-04T10:30:42.000Z",
});

function harness(results: WorkflowStepResult[]) {
  const task = { id: "FN-295", workflowStepResults: results } as Task;
  const store = {
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
  };
  return { task, store, deps: { store: store as never, getRunContextFor: () => undefined } };
}

describe("remediation archive scope", () => {
  it("archives only the gate being remediated and leaves an older failed gate recoverable", async () => {
    const { task, store, deps } = harness([stalePlanReview, result({ verdict: "REVISE", reviewKind: "code" })]);

    await clearTerminalStepFailuresForRetry(deps, "FN-295", "archive");

    expect(store.updateTask).toHaveBeenCalledOnce();
    const byId = new Map((task.workflowStepResults ?? []).map((entry) => [entry.workflowStepId, entry]));
    /* The remediated gate becomes the archived carrier that hands its ledger to the next reviewer. */
    expect(byId.get("code-review")).toMatchObject({ status: "skipped", remediationArchivedFromStatus: "failed" });
    /* The unrelated stale gate keeps the shape the audited operator bypass can select. */
    expect(byId.get("plan-review")).toEqual(stalePlanReview);
    expect(getLatestFailedPreMergeReviewStep(task)).toMatchObject({ workflowStepId: "plan-review" });
  });

  it("archives an advisory_failure remediation target", async () => {
    const advisory = result({ workflowStepId: "browser-verification", workflowStepName: "Browser", status: "advisory_failure" });
    const { task, deps } = harness([stalePlanReview, advisory]);

    await clearTerminalStepFailuresForRetry(deps, "FN-295", "archive");

    const byId = new Map((task.workflowStepResults ?? []).map((entry) => [entry.workflowStepId, entry]));
    expect(byId.get("browser-verification")).toMatchObject({ status: "skipped", remediationArchivedFromStatus: "advisory_failure" });
    expect(byId.get("plan-review")).toEqual(stalePlanReview);
  });

  it("leaves passed and pending evidence untouched", async () => {
    const passed = result({ workflowStepId: "documentation-delivery", workflowStepName: "Documentation", status: "passed" });
    const { task, deps } = harness([passed, result({ reviewKind: "code" })]);

    await clearTerminalStepFailuresForRetry(deps, "FN-295", "archive");

    expect((task.workflowStepResults ?? []).find((entry) => entry.workflowStepId === "documentation-delivery")).toEqual(passed);
  });

  it("keeps the blanket contract for callers that do not scope the archive", () => {
    const archived = archiveTerminalWorkflowStepFailures([stalePlanReview, result({ reviewKind: "code" })], "2026-09-05T00:00:00.000Z");
    expect(archived?.every((entry) => entry.status === "skipped")).toBe(true);
    const scoped = archiveTerminalWorkflowStepFailures(
      [stalePlanReview, result({ reviewKind: "code" })],
      "2026-09-05T00:00:00.000Z",
      { workflowStepIds: new Set(["code-review"]) },
    );
    expect(scoped?.map((entry) => entry.status)).toEqual(["failed", "skipped"]);
  });
});
