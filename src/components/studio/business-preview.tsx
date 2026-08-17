import { computeBriefCompleteness } from "@/lib/studio/site-brief/readiness";
import type { SiteBriefV1 } from "@/lib/studio/site-brief/schema";

export function BusinessPreview({ brief }: { brief: Partial<SiteBriefV1> }) {
  const c = computeBriefCompleteness(brief);
  const placeholder = (v?: string) =>
    v && v.trim() ? v : "— not yet provided —";
  return (
    <div className="rounded-xl border border-line bg-white p-6">
      <h2 className="text-xl font-bold text-navy">
        {brief.businessName ? brief.businessName : "— not yet provided —"}
      </h2>
      {brief.tagline && <p className="text-sm text-slate">{brief.tagline}</p>}
      {!brief.tagline && (
        <p className="text-sm text-slate-500">— not yet provided: tagline —</p>
      )}
      <p className="mt-3 text-sm text-slate">
        {placeholder(brief.description)}
      </p>
      <div className="mt-4 grid gap-2 text-sm">
        <div>
          <span className="font-semibold">Phone: </span>
          {brief.phone ? (
            <a href={`tel:${brief.phone}`} rel="noopener noreferrer">
              {brief.phone}
            </a>
          ) : (
            "— not yet provided —"
          )}
        </div>
        <div>
          <span className="font-semibold">Email: </span>
          {brief.email ? (
            <a href={`mailto:${brief.email}`}>{brief.email}</a>
          ) : (
            "— not yet provided —"
          )}
        </div>
        <div>
          <span className="font-semibold">Address: </span>
          {placeholder(brief.address)}
        </div>
        {brief.mapsLink && (
          <a
            href={brief.mapsLink}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-brandblue underline"
          >
            {brief.mapsLink}
          </a>
        )}
      </div>
      <p className="mt-4 text-xs text-slate-500">
        Brief completeness: {c.score}% — {c.missingRequired.length} required
        missing
      </p>
      {c.placeholders.length > 0 && (
        <ul className="mt-2 text-xs text-amber-700">
          {c.placeholders.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
