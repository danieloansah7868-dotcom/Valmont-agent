import type { SiteBriefV1 } from "./site-brief/schema";

export type BriefField = keyof SiteBriefV1;

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Fields whose value differs between two versions of a Brief. */
export function changedFields(
  base: Partial<SiteBriefV1>,
  next: Partial<SiteBriefV1>,
): BriefField[] {
  const keys = new Set<string>([...Object.keys(base), ...Object.keys(next)]);
  const changed: BriefField[] = [];
  for (const key of keys) {
    if (
      !sameValue(
        (base as Record<string, unknown>)[key],
        (next as Record<string, unknown>)[key],
      )
    ) {
      changed.push(key as BriefField);
    }
  }
  return changed;
}

export interface MergeOutcome {
  /** The Brief to save, when the two sets of edits do not overlap. */
  merged: SiteBriefV1 | null;
  /** Fields both people changed. Non-empty means a person must decide. */
  conflictingFields: BriefField[];
  /** Fields only we changed, reapplied on top of the server's version. */
  reappliedFields: BriefField[];
}

/**
 * Works out whether our unsaved edit can be safely replayed on top of the
 * version that is now on the server.
 *
 * `base` is the version we started editing from, `mine` is what is on screen,
 * `theirs` is what the server holds now. If the other writer touched a
 * different set of fields, our changes are re-applied to their version and the
 * result can be saved without losing either side's work. If both changed the
 * same field, nothing is merged and the caller must ask the person what to do —
 * neither version is ever thrown away silently.
 */
export function mergeBriefs(
  base: SiteBriefV1,
  mine: SiteBriefV1,
  theirs: SiteBriefV1,
): MergeOutcome {
  const myChanges = changedFields(base, mine);
  const theirChanges = changedFields(base, theirs);
  const theirChangeSet = new Set<string>(theirChanges);

  const conflictingFields = myChanges.filter(
    (field) =>
      theirChangeSet.has(field) &&
      !sameValue(
        (mine as Record<string, unknown>)[field],
        (theirs as Record<string, unknown>)[field],
      ),
  );

  if (conflictingFields.length > 0) {
    return { merged: null, conflictingFields, reappliedFields: [] };
  }

  const merged = { ...theirs } as Record<string, unknown>;
  for (const field of myChanges) {
    merged[field] = (mine as Record<string, unknown>)[field];
  }
  return {
    merged: merged as SiteBriefV1,
    conflictingFields: [],
    reappliedFields: myChanges,
  };
}
