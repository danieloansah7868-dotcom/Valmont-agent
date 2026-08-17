import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Valmont — Private portfolio", template: "%s · Valmont" },
  description:
    "Private Valmont workspace. The internal portfolio of Valmont products, including Valmont Agent — a private, approval-first coding agent. GitHub sign-in required.",
  applicationName: "Valmont",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0A1F44",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
