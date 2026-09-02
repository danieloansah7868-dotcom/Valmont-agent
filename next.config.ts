import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Dev-only Content-Security-Policy.
 *
 * React's development build uses eval() to rebuild callstacks across
 * environments, and Turbopack serves HMR chunks that the browser may request
 * from 127.0.0.1 even when the server is bound to 0.0.0.0. Production keeps the
 * strict policy below with no 'unsafe-eval' and no websocket origins.
 *
 * 'unsafe-inline' for scripts remains in production because the App Router
 * streams its React Server Components payload as inline <script> tags and
 * the static headers() below cannot carry a per-request nonce; moving to a
 * nonce-based policy needs the CSP header set from `src/proxy.ts` per
 * request and is tracked in docs/SECURITY.md. Everything else that does not
 * need inline execution is locked down: no plugins, no framed content, no
 * cross-origin form posts beyond the GitHub sign-in.
 */
const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";
const connectSrc = isDev
  ? "connect-src 'self' ws: wss: http: https:"
  : "connect-src 'self'";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Browsers reach the 0.0.0.0 dev server as localhost/127.0.0.1; both must be
  // allowed or Next.js blocks the HMR and chunk requests as cross-origin.
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  experimental: {
    typedEnv: false,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              scriptSrc,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https://avatars.githubusercontent.com",
              connectSrc,
              "object-src 'none'",
              "frame-src 'none'",
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self' https://github.com",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
