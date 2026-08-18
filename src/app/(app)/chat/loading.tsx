export default function ChatLoading() {
  return (
    <div
      className="chat-shell fixed inset-x-0 top-16 bottom-16 flex overflow-hidden bg-navy md:bottom-0"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">Loading chat…</span>
      <aside className="hidden w-[280px] shrink-0 border-r border-ivory/10 bg-navy-900 lg:block">
        <div className="border-b border-ivory/10 px-4 py-4">
          <div className="h-2.5 w-24 rounded bg-ivory/15" />
          <div className="mt-2 h-5 w-40 rounded bg-ivory/15" />
        </div>
        <div className="space-y-2 p-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="rounded-xl border border-ivory/10 p-3"
            >
              <div className="h-3 w-4/5 rounded bg-ivory/15" />
              <div className="mt-2 h-2.5 w-3/5 rounded bg-ivory/10" />
            </div>
          ))}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-ivory/10 bg-navy-900 px-6 py-4">
          <div className="h-4 w-64 max-w-full rounded bg-ivory/15" />
          <div className="mt-2 h-2.5 w-48 rounded bg-ivory/10" />
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-sm font-semibold text-ivory/70">Opening chat…</p>
        </div>
      </section>
    </div>
  );
}
