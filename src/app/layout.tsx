import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Valmont — Portfolio", template: "%s · Valmont" },
  description:
    "The Valmont portfolio — a connected ecosystem of ventures spanning payments, banking, data, web, AI, gadgets, electrical services, and advertising.",
  applicationName: "Valmont",
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
