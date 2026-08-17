export const THEME_IDS = [
  "modern-bold",
  "premium-elegant",
  "clean-corporate",
  "friendly-colourful",
  "minimal-professional",
  "luxury",
  "community",
] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export interface ThemeTokens {
  colors: { primary: string; accent: string; surface: string; text: string };
  typography: { heading: string; body: string };
  layout: { radius: string; spacing: string };
  cardStyle: string;
  navStyle: string;
}

export interface ThemeManifest {
  id: ThemeId;
  label: string;
  description: string;
  tokens: ThemeTokens;
}

export const THEME_REGISTRY_VERSION = 1;

export const themes: ThemeManifest[] = [
  {
    id: "modern-bold",
    label: "Modern & Bold",
    description: "Strong type, high contrast.",
    tokens: {
      colors: {
        primary: "#0f2452",
        accent: "#c46a2a",
        surface: "#fffdf7",
        text: "#1a1a1a",
      },
      typography: { heading: "Geist", body: "Geist" },
      layout: { radius: "1rem", spacing: "1rem" },
      cardStyle: "shadow",
      navStyle: "dark",
    },
  },
  {
    id: "premium-elegant",
    label: "Premium & Elegant",
    description: "Refined and spacious.",
    tokens: {
      colors: {
        primary: "#1c274e",
        accent: "#8b6b3d",
        surface: "#faf8f5",
        text: "#1e1e1e",
      },
      typography: { heading: "Serif", body: "Sans" },
      layout: { radius: "0.75rem", spacing: "1.25rem" },
      cardStyle: "border",
      navStyle: "light",
    },
  },
  {
    id: "clean-corporate",
    label: "Clean & Corporate",
    description: "Clear and trustworthy.",
    tokens: {
      colors: {
        primary: "#0f3050",
        accent: "#2a7a6b",
        surface: "#ffffff",
        text: "#222",
      },
      typography: { heading: "Sans", body: "Sans" },
      layout: { radius: "0.5rem", spacing: "1rem" },
      cardStyle: "border",
      navStyle: "light",
    },
  },
  {
    id: "friendly-colourful",
    label: "Friendly & Colourful",
    description: "Warm and approachable.",
    tokens: {
      colors: {
        primary: "#2a3d8f",
        accent: "#e85d3f",
        surface: "#fff7ed",
        text: "#1a1a1a",
      },
      typography: { heading: "Rounded", body: "Rounded" },
      layout: { radius: "1.25rem", spacing: "1rem" },
      cardStyle: "shadow",
      navStyle: "dark",
    },
  },
  {
    id: "minimal-professional",
    label: "Minimal & Professional",
    description: "Quiet and focused.",
    tokens: {
      colors: {
        primary: "#111827",
        accent: "#6b7280",
        surface: "#ffffff",
        text: "#111827",
      },
      typography: { heading: "Sans", body: "Sans" },
      layout: { radius: "0.25rem", spacing: "1.5rem" },
      cardStyle: "minimal",
      navStyle: "dark",
    },
  },
  {
    id: "luxury",
    label: "Luxury",
    description: "Dark, gold accents.",
    tokens: {
      colors: {
        primary: "#0a0a0a",
        accent: "#c9a96a",
        surface: "#111111",
        text: "#f5f5f5",
      },
      typography: { heading: "Serif", body: "Serif" },
      layout: { radius: "0rem", spacing: "1.5rem" },
      cardStyle: "outline",
      navStyle: "dark",
    },
  },
  {
    id: "community",
    label: "Community-Focused",
    description: "Open and inviting.",
    tokens: {
      colors: {
        primary: "#1b5e3b",
        accent: "#d4a017",
        surface: "#f6fdf7",
        text: "#1a2e1a",
      },
      typography: { heading: "Sans", body: "Sans" },
      layout: { radius: "0.75rem", spacing: "1rem" },
      cardStyle: "shadow",
      navStyle: "light",
    },
  },
];

export function isThemeId(v: string): v is ThemeId {
  return (THEME_IDS as readonly string[]).includes(v);
}
export const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

export function getTheme(id: string): ThemeManifest | undefined {
  return themes.find((theme) => theme.id === id);
}
