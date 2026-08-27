import Link from "next/link";
import { Logo } from "@/components/logo";

export default function CustomerAccountLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="min-h-screen bg-ivory-50">
      <header className="border-b border-line bg-paper/95">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Logo href="/" />
          <Link
            href="/"
            className="text-sm font-semibold text-slate transition-colors hover:text-navy"
          >
            Back to Valmont
          </Link>
        </div>
      </header>
      {children}
    </main>
  );
}
