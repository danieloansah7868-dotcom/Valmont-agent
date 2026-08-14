import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Valmont Agent", template: "%s · Valmont Agent" },
  description:
    "A private, approval-first AI coding agent for your GitHub repositories.",
  applicationName: "Valmont Agent",
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
