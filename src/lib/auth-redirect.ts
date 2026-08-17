const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export class InvalidAuthOriginError extends Error {
  constructor(source: "APP_URL" | "request URL") {
    super(`${source} must be an absolute HTTP or HTTPS origin`);
    this.name = "InvalidAuthOriginError";
  }
}

function parseUrl(value: string, source: "APP_URL" | "request URL"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidAuthOriginError(source);
  }

  if (
    !HTTP_PROTOCOLS.has(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    (source === "APP_URL" && (url.pathname !== "/" || url.search || url.hash))
  ) {
    throw new InvalidAuthOriginError(source);
  }

  return new URL(url.origin);
}

/**
 * Returns the canonical origin used by browser-facing OAuth URLs.
 *
 * A configured APP_URL is authoritative and must be an origin, not a URL with
 * credentials or application-specific components. Invalid configured values
 * fail closed rather than falling back to request metadata. The request URL is
 * retained only as a backwards-compatible fallback when APP_URL is absent.
 */
export function authOrigin(
  requestUrl: string | URL,
  appUrl: string | undefined = process.env.APP_URL,
): URL {
  if (appUrl !== undefined) return parseUrl(appUrl, "APP_URL");
  return parseUrl(requestUrl.toString(), "request URL");
}
