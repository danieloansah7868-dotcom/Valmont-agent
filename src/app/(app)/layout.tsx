import { AppShell } from "@/components/app-shell";
import { requireSessionUser } from "@/lib/auth";

export default async function ApplicationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Live mode by default: unauthenticated visitors are redirected to connect.
  const user = await requireSessionUser();
  return <AppShell user={user}>{children}</AppShell>;
}
