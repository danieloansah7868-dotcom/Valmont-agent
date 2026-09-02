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
 * Returns the canonical public origin of this deployment.
 *
 * A configured APP_URL is authoritative and must be an origin, not a URL with
 * credentials or application-specific components. Invalid configured values
 * fail closed rather than falling back to request metadata. The request URL is
 * retained only as a backwards-compatible fallback when APP_URL is absent.
 *
 * This is the ONLY correct source for any absolute URL the server mints for a
 * third party — OAuth redirects, verification and password-reset emails,
 * merchant/customer notification links and the Valmont Pay callback URL.
 * `request.nextUrl.origin` must not be used for those: behind a proxy or the
 * standalone server it reflects the bind address (`http://0.0.0.0:3000`) or a
 * caller-controlled Host header, so links would be dead or attacker-chosen.
 */
export function authOrigin(
  requestUrl: string | URL,
  appUrl: string | undefined = process.env.APP_URL,
): URL {
  if (appUrl !== undefined) return parseUrl(appUrl, "APP_URL");
  return parseUrl(requestUrl.toString(), "request URL");
}

/**
 * The public origin as a string without a trailing slash, for callers that
 * concatenate paths. Same rules as {@link authOrigin}.
 */
export function publicOrigin(
  requestUrl: string | URL,
  appUrl: string | undefined = process.env.APP_URL,
): string {
  return authOrigin(requestUrl, appUrl).origin;
}
