import { describe, expect, it } from "vitest";
import { changedFields, mergeBriefs } from "./merge";
import { createDefaultBrief } from "./site-brief/defaults";

const base = createDefaultBrief({
  businessName: "Adom Fashion",
  phone: "+233201234567",
  tagline: "Style that fits",
  services: ["Tailoring"],
});

describe("changedFields", () => {
  it("finds nothing when the two versions are identical", () => {
    expect(changedFields(base, { ...base })).toEqual([]);
  });

  it("finds a single edited field", () => {
    expect(changedFields(base, { ...base, tagline: "New words" })).toEqual([
      "tagline",
    ]);
  });

  it("compares lists by content, not by reference", () => {
    expect(changedFields(base, { ...base, services: ["Tailoring"] })).toEqual(
      [],
    );
    expect(
      changedFields(base, { ...base, services: ["Tailoring", "Repairs"] }),
    ).toEqual(["services"]);
  });

  it("notices a field that was added or removed", () => {
    const withoutTagline = { ...base };
    delete (withoutTagline as Record<string, unknown>).tagline;
    expect(changedFields(base, withoutTagline)).toEqual(["tagline"]);
  });
});

describe("mergeBriefs", () => {
  it("replays my edit on top of theirs when we touched different fields", () => {
    const mine = { ...base, phone: "+233559999999" };
    const theirs = { ...base, selectedTheme: "luxury" as const };

    const outcome = mergeBriefs(base, mine, theirs);

    expect(outcome.conflictingFields).toEqual([]);
    expect(outcome.reappliedFields).toEqual(["phone"]);
    expect(outcome.merged?.phone).toBe("+233559999999");
    expect(outcome.merged?.selectedTheme).toBe("luxury");
  });

  it("keeps every other field the other writer changed", () => {
    const mine = { ...base, tagline: "Mine" };
    const theirs = {
      ...base,
      address: "12 Oxford Street",
      hours: "Mon-Fri 9-5",
    };

    const outcome = mergeBriefs(base, mine, theirs);

    expect(outcome.merged?.tagline).toBe("Mine");
    expect(outcome.merged?.address).toBe("12 Oxford Street");
    expect(outcome.merged?.hours).toBe("Mon-Fri 9-5");
  });

  it("refuses to merge when both changed the same field differently", () => {
    const mine = { ...base, businessName: "Adom Couture" };
    const theirs = { ...base, businessName: "Adom Tailors" };

    const outcome = mergeBriefs(base, mine, theirs);

    expect(outcome.merged).toBeNull();
    expect(outcome.conflictingFields).toEqual(["businessName"]);
    expect(outcome.reappliedFields).toEqual([]);
  });

  it("is not a conflict when both made the identical change", () => {
    const same = { ...base, businessName: "Adom Couture" };
    const outcome = mergeBriefs(base, { ...same }, { ...same });
    expect(outcome.merged).not.toBeNull();
    expect(outcome.conflictingFields).toEqual([]);
  });

  it("reports every conflicting field, not only the first", () => {
    const mine = { ...base, businessName: "A", tagline: "B" };
    const theirs = { ...base, businessName: "C", tagline: "D" };
    const outcome = mergeBriefs(base, mine, theirs);
    expect(outcome.conflictingFields.sort()).toEqual([
      "businessName",
      "tagline",
    ]);
  });

  it("returns the server version unchanged when I changed nothing", () => {
    const theirs = { ...base, tagline: "Server wins" };
    const outcome = mergeBriefs(base, { ...base }, theirs);
    expect(outcome.reappliedFields).toEqual([]);
    expect(outcome.merged).toEqual(theirs);
  });

  it("never loses business details when only the theme differs on their side", () => {
    const mine = { ...base, description: "Bespoke tailoring in Accra." };
    const theirs = { ...base, selectedTheme: "premium-elegant" as const };
    const outcome = mergeBriefs(base, mine, theirs);
    expect(outcome.merged?.description).toBe("Bespoke tailoring in Accra.");
    expect(outcome.merged?.phone).toBe("+233201234567");
    expect(outcome.merged?.services).toEqual(["Tailoring"]);
  });
});
