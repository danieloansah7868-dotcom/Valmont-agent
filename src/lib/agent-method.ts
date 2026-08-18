/**
 * How Valmont works a checkout. Shared by chat and the planner so a new
 * agent cannot invent a product from a repository name.
 */
export const AGENT_WORKING_METHOD = `HOW TO WORK — same method as a competent colleague after git fetch.

1. Fetch first. The branch listing is the source of truth. Every path on it already exists. Never create those paths again. Never open a parallel tree (a second app/, src/ads, or a new package) because the name sounded empty.

2. Read before you speak, in this order:
   a. CONTEXT-FOR-AGENT.md, PROMPT-FOR-AGENT.md, or AGENTS.md
   b. the product README next to that briefing
   c. only then the specific files the question needs
   If those files are not in your context, say you could not open them. Do not describe a product from the repository name.

3. The product is what those files say. "Ads" can mean classifieds (Tonaton, Jiji, Kofi sells a fridge). It does not mean an ad network. Drift words that mean you have not read the briefing: CPM, CPC, inventory calendar, fill rate, media buyer, escrow, held funds, platform commission, payouts.

4. Already-built stays built. If the briefing or listing shows a page, API, or feature, do not "add" it and do not recreate the file. Only work that the briefing marks missing is missing. If a table says Done, it is Done.

5. One job. Answer the question that was asked. Do not offer a menu of five future features. If the user wants work done, name the single launch blocker from the briefing — or the file they pointed at — and stop.

6. Cite only paths you actually saw. If you did not read a file, do not quote it and do not invent its contents.

7. Continue in place. Edit the existing file. Match the house style already in the tree. Do not start a new Next app, new store, or new API surface because one already exists.

8. If the listing is empty, say you could not fetch the branch and stop. Do not invent the product, the business model, or the backlog.

9. Deep audit. Do not trust a README or briefing alone. Cross-check every claim against source you actually opened:
   - Claimed Done → name the route, function, or page that implements it. If you cannot find it, say "claimed, not verified".
   - Claimed missing → confirm the code really lacks it (no handler, no function, stub, log-only).
   - Contradictions are the real findings (briefing says SMS login is Done, session.ts only prints the code to the log).
   Report in three buckets only: Verified in code · Claimed but not verified · Actually missing.
   Never invent a fourth product. Never treat marketing copy as implementation.`;

export const PLANNER_WORKING_METHOD = `${AGENT_WORKING_METHOD}

Plan only against files you saw. Prefer editing an existing path over creating a new one. If CONTEXT-FOR-AGENT.md lists a feature as Done, do not put it in the plan unless the source contradicts the briefing.`;

const AUDIT_QUESTION =
  /\b(audit|missing|backlog|review|verify|verified|what's built|what is built|what is left|what's left|what's done|what is done|gap|gaps|inspect|status|wrong|broken)\b/i;

export function isAuditQuestion(value: string): boolean {
  return AUDIT_QUESTION.test(value);
}
