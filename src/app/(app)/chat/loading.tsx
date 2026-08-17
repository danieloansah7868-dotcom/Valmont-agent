export default function ChatLoading() {
  return (
    <div
      className="fixed inset-x-0 top-16 bottom-16 flex overflow-hidden bg-ivory-50 md:bottom-0"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">Loading chat…</span>
      <aside className="hidden w-[280px] shrink-0 border-r border-line bg-white lg:block">
        <div className="border-b border-line px-4 py-4">
          <div className="skeleton h-2.5 w-24 rounded" />
          <div className="skeleton mt-2 h-5 w-40 rounded" />
        </div>
        <div className="space-y-2 p-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="rounded-xl border border-line p-3">
              <div className="skeleton h-3 w-4/5 rounded" />
              <div className="skeleton mt-2 h-2.5 w-3/5 rounded" />
            </div>
          ))}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-line bg-white px-6 py-4">
          <div className="skeleton h-4 w-64 max-w-full rounded" />
          <div className="skeleton mt-2 h-2.5 w-48 rounded" />
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-sm font-semibold text-slate">Opening chat…</p>
        </div>
      </section>
    </div>
  );
}
