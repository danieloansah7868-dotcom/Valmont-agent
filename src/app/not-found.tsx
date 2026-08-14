import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="text-center">
        <p className="text-xs font-bold tracking-widest text-[#347057] uppercase">
          404
        </p>
        <h1 className="mt-3 text-2xl font-bold">
          This page could not be found
        </h1>
        <p className="mt-2 text-sm text-[#728078]">
          The task may have been removed or the link is invalid.
        </p>
        <Link href="/dashboard" className="btn-primary mt-5">
          Return to dashboard
        </Link>
      </div>
    </main>
  );
}
