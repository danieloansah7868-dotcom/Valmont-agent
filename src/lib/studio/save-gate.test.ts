import { describe, expect, it } from "vitest";
import { evaluateSaveGate, type SaveGateState } from "./save-gate";

function state(overrides: Partial<SaveGateState> = {}): SaveGateState {
  return {
    inFlight: false,
    awaitingConflictChoice: false,
    hasPendingEdit: true,
    isValid: true,
    ...overrides,
  };
}

describe("autosave gate", () => {
  it("sends a valid queued edit when nothing is blocking", () => {
    expect(evaluateSaveGate(state())).toEqual({ send: true });
  });

  // Regression cover for an independent-review finding: after a conflict was
  // detected the editor had already adopted the newer revision, so the next
  // autosave tick would write this tab's whole version over the other tab's
  // work before the owner had chosen which one to keep.
  it("refuses to save while a conflict choice is outstanding", () => {
    expect(evaluateSaveGate(state({ awaitingConflictChoice: true }))).toEqual({
      send: false,
      reason: "awaiting-conflict-choice",
    });
  });

  it("stays frozen even when the queued edit is valid and current", () => {
    const decision = evaluateSaveGate(
      state({ awaitingConflictChoice: true, isValid: true, inFlight: false }),
    );
    expect(decision.send).toBe(false);
  });

  it("resumes once the owner has chosen", () => {
    expect(evaluateSaveGate(state({ awaitingConflictChoice: false }))).toEqual({
      send: true,
    });
  });

  it("serializes requests so a save cannot overtake one in flight", () => {
    expect(evaluateSaveGate(state({ inFlight: true }))).toEqual({
      send: false,
      reason: "in-flight",
    });
  });

  it("does nothing when there is no queued edit", () => {
    expect(evaluateSaveGate(state({ hasPendingEdit: false }))).toEqual({
      send: false,
      reason: "nothing-queued",
    });
  });

  it("never sends a brief the server would reject", () => {
    expect(evaluateSaveGate(state({ isValid: false }))).toEqual({
      send: false,
      reason: "invalid",
    });
  });

  it("reports the conflict before the in-flight state is even relevant", () => {
    // Ordering matters: a caller must not learn 'try again shortly' when the
    // real reason is an unresolved conflict.
    const decision = evaluateSaveGate(
      state({ inFlight: false, awaitingConflictChoice: true }),
    );
    expect(decision).toEqual({
      send: false,
      reason: "awaiting-conflict-choice",
    });
  });
});
