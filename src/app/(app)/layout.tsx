import { AppShell } from "@/components/app-shell";
import { getSessionUser } from "@/lib/auth";

export default async function ApplicationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();
  return <AppShell user={user}>{children}</AppShell>;
}
