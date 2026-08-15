import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Valmont Agent", template: "%s · Valmont Agent" },
  description:
    "A private, approval-first AI coding agent for your GitHub repositories.",
  applicationName: "Valmont Agent",
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
