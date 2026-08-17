import {
  computeBriefCompleteness,
  displayValue,
} from "@/lib/studio/site-brief/readiness";
import type { SiteBriefV1 } from "@/lib/studio/site-brief/schema";
import { getTheme } from "@/lib/studio/themes";
import { getTemplate } from "@/lib/studio/templates";
import { isHttpsSafeUrl } from "@/lib/studio/site-brief/schema";

/**
 * A safe, read-only preview of the future website. It shows only what the owner
 * typed: no invented prices, testimonials, delivery promises or payment claims.
 * Missing information is shown as a clearly-marked placeholder.
 */
export function BusinessPreview({ brief }: { brief: Partial<SiteBriefV1> }) {
  const completeness = computeBriefCompleteness(brief);
  const theme = brief.selectedTheme ? getTheme(brief.selectedTheme) : undefined;
  const template = brief.selectedTemplate
    ? getTemplate(brief.selectedTemplate)
    : undefined;

  const name = displayValue(brief.businessName);
  const tagline = displayValue(brief.tagline);
  const description = displayValue(brief.description);
  const address = displayValue(brief.address);
  const hours = displayValue(brief.hours);

  // Only render a map link when it passes the same https safety check the
  // schema applies. An unvalidated value is never turned into an anchor.
  const mapsLink =
    brief.mapsLink && isHttpsSafeUrl(brief.mapsLink) ? brief.mapsLink : null;

  const accent = theme?.tokens.colors.primary ?? "#0b2545";

  return (
    <section
      aria-label="Website preview"
      data-testid="business-preview"
      className="overflow-hidden rounded-xl border border-line bg-white"
    >
      <header className="p-4" style={{ borderTop: `4px solid ${accent}` }}>
        <p className="text-[11px] uppercase tracking-wide text-slate-500">
          Preview{template ? ` · ${template.label}` : ""}
          {theme ? ` · ${theme.label}` : ""}
        </p>
        <h2
          className={`mt-1 text-lg font-bold ${name.isPlaceholder ? "text-slate-400 italic" : "text-navy"}`}
        >
          {name.text}
        </h2>
        <p
          className={`text-sm ${tagline.isPlaceholder ? "text-slate-400 italic" : "text-slate"}`}
        >
          {tagline.text}
        </p>
      </header>

      <div className="border-t border-line p-4 text-sm">
        <p
          className={
            description.isPlaceholder ? "text-slate-400 italic" : "text-slate"
          }
        >
          {description.text}
        </p>

        <dl className="mt-3 grid gap-2">
          <PreviewRow
            label="Phone"
            value={brief.phone}
            href={brief.phone ? `tel:${brief.phone}` : undefined}
          />
          <PreviewRow
            label="WhatsApp"
            value={brief.whatsapp}
            href={
              brief.whatsapp
                ? `https://wa.me/${brief.whatsapp.replace(/\D/g, "")}`
                : undefined
            }
          />
          <PreviewRow
            label="Email"
            value={brief.email}
            href={brief.email ? `mailto:${brief.email}` : undefined}
          />
          <div>
            <dt className="inline font-semibold">Address: </dt>
            <dd
              className={`inline ${address.isPlaceholder ? "text-slate-400 italic" : ""}`}
            >
              {address.text}
            </dd>
          </div>
          <div>
            <dt className="inline font-semibold">Opening hours: </dt>
            <dd
              className={`inline ${hours.isPlaceholder ? "text-slate-400 italic" : ""}`}
            >
              {hours.text}
            </dd>
          </div>
        </dl>

        {mapsLink && (
          <a
            href={mapsLink}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="mt-2 inline-block break-all text-brandblue underline"
          >
            View on the map
          </a>
        )}

        {(brief.services?.length ?? 0) > 0 && (
          <PreviewList title="Services" items={brief.services!} />
        )}
        {(brief.products?.length ?? 0) > 0 && (
          <PreviewList
            title="Products"
            items={brief.products!.map((product) => product.name)}
          />
        )}
        {(brief.serviceAreas?.length ?? 0) > 0 && (
          <PreviewList title="Areas served" items={brief.serviceAreas!} />
        )}
      </div>

      <footer className="border-t border-line bg-slate-50 p-3 text-xs text-slate-600">
        Brief completeness: {completeness.score}% ·{" "}
        {completeness.missingRequired.length} required item
        {completeness.missingRequired.length === 1 ? "" : "s"} still needed.
        This is a plan, not a live website — nothing here can take orders or
        payments.
      </footer>
    </section>
  );
}

function PreviewRow({
  label,
  value,
  href,
}: {
  label: string;
  value?: string;
  href?: string;
}) {
  const shown = displayValue(value);
  return (
    <div>
      <dt className="inline font-semibold">{label}: </dt>
      <dd className="inline">
        {href && !shown.isPlaceholder ? (
          <a href={href} rel="noopener noreferrer" className="underline">
            {shown.text}
          </a>
        ) : (
          <span className={shown.isPlaceholder ? "text-slate-400 italic" : ""}>
            {shown.text}
          </span>
        )}
      </dd>
    </div>
  );
}

function PreviewList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h3>
      <ul className="mt-1 list-disc pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
