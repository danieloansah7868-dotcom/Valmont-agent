import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The restore UI must not quietly drop information the server took care to
 * report. An independent review found exactly that: the API returned
 * `skippedMemories`, `notice` and, on a partial failure, `committed`, and the
 * client's type declared none of them, so the owner was never shown them.
 *
 * The test runner is `environment: "node"` and this repository deliberately
 * carries no jsdom or Testing Library, so the component cannot be rendered
 * here. What can still be enforced — cheaply and without a new dependency — is
 * the contract: every field the server can send must be named somewhere in the
 * component that consumes it. That is enough to fail the build the next time a
 * field is added to `ImportSummary` and the UI is left behind.
 *
 * This is a coarse check by design. It proves the field is referenced, not
 * that it is rendered well; the wording of what the owner actually sees is
 * asserted server-side in `backup-route.test.ts` and, once a browser is
 * available, in the e2e suite.
 */
const CLIENT = readFileSync(
  join(process.cwd(), "src/components/studio/backup-controls.tsx"),
  "utf8",
);

/**
 * Every key the import route can put in a response body.
 *
 * Kept as a literal list rather than derived from the type, because the point
 * is to notice when the two drift apart — deriving both sides from one source
 * would defeat the check.
 */
const SUCCESS_FIELDS = [
  "sourceVersion",
  "chatSessions",
  "memories",
  "skippedMemories",
  "studioDrafts",
  "remappedDraftIds",
  "customerAccounts",
  "skippedCustomerAccounts",
  "customerSessions",
  "customerTokens",
  "customDomains",
  "skippedDomains",
  "atomicity",
  "notice",
] as const;

const FAILURE_FIELDS = ["partial", "committed"] as const;

describe("the restore UI consumes everything the import route reports", () => {
  it.each(SUCCESS_FIELDS)("handles the %s field of a success body", (field) => {
    expect(
      CLIENT.includes(field),
      `The import route can return "${field}", but backup-controls.tsx never mentions it. ` +
        `Either surface it to the owner or add a comment saying why it is deliberately not shown.`,
    ).toBe(true);
  });

  it.each(FAILURE_FIELDS)(
    "handles the %s field of a partial-failure body",
    (field) => {
      expect(
        CLIENT.includes(field),
        `A partial import returns "${field}", but backup-controls.tsx never mentions it. ` +
          `A partial import must never be shown as a plain failure.`,
      ).toBe(true);
    },
  );

  it("tells the owner a retry duplicates what already landed", () => {
    // The specific hazard of a partial import: the chat half committed, so
    // importing the same file again doubles it. Warning about that is the
    // whole reason the partial state is distinguished from a failure.
    expect(CLIENT).toMatch(/second copy|duplicat/i);
  });

  it("keeps the ImportSummary shape in step with the server's", () => {
    // A field renamed on the server and not here would leave the client
    // reading `undefined` and rendering nothing, with no type error, because
    // the client declares its own structural copy of the interface.
    const server = readFileSync(
      join(process.cwd(), "src/lib/studio/backup.ts"),
      "utf8",
    );
    const block = /export interface ImportSummary \{([\s\S]*?)\n\}/.exec(
      server,
    );
    expect(block, "ImportSummary is no longer declared as expected").not.toBe(
      null,
    );

    const serverFields = [...block![1].matchAll(/^\s{2}(\w+)\??:/gm)].map(
      (match) => match[1],
    );
    expect(serverFields.length).toBeGreaterThan(0);
    expect([...serverFields].sort()).toEqual(
      [...SUCCESS_FIELDS].filter((f) => f !== "notice").sort(),
    );
  });
});
