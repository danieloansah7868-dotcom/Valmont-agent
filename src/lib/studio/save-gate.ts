/**
 * Decides whether the draft editor may send a save right now.
 *
 * This lives outside the React component so the rule can be tested directly.
 * The editor has no unit-test environment in this repository (no DOM test
 * runner is installed), and this is the one piece of its behaviour where being
 * wrong loses somebody's work, so it is worth isolating.
 */
export interface SaveGateState {
  /** A request is already in flight; saves are serialized. */
  inFlight: boolean;
  /**
   * Overlapping edits were detected and the owner has not yet chosen which
   * version to keep.
   */
  awaitingConflictChoice: boolean;
  /** There is an edit queued to send. */
  hasPendingEdit: boolean;
  /** The queued edit passes schema validation. */
  isValid: boolean;
}

export type SaveGateDecision =
  | { send: true }
  | {
      send: false;
      reason:
        "in-flight" | "awaiting-conflict-choice" | "nothing-queued" | "invalid";
    };

/**
 * `awaiting-conflict-choice` is checked before anything else that could let a
 * write through. While two versions are on screen the queued edit must stay
 * queued: sending it would write the whole on-screen version over the other
 * tab's work, which is exactly what showing the choice is meant to prevent.
 */
export function evaluateSaveGate(state: SaveGateState): SaveGateDecision {
  if (state.inFlight) return { send: false, reason: "in-flight" };
  if (state.awaitingConflictChoice)
    return { send: false, reason: "awaiting-conflict-choice" };
  if (!state.hasPendingEdit) return { send: false, reason: "nothing-queued" };
  if (!state.isValid) return { send: false, reason: "invalid" };
  return { send: true };
}
