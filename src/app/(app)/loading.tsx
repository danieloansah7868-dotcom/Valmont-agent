export default function AppLoading() {
  return (
    <div
      className="mx-auto max-w-[1180px] px-4 py-7 sm:px-7 sm:py-9"
      role="status"
      aria-live="polite"
    >
      <span className="sr-only">Loading…</span>
      <div className="skeleton h-3 w-32 rounded" />
      <div className="skeleton mt-3 h-8 w-72 rounded" />
      <div className="skeleton mt-3 h-3 w-96 max-w-full rounded" />
      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="card p-5">
            <div className="flex items-start justify-between">
              <span className="skeleton size-9 rounded-lg" />
              <span className="skeleton h-6 w-10 rounded" />
            </div>
            <div className="skeleton mt-4 h-3 w-4/5 rounded" />
            <div className="skeleton mt-2 h-2.5 w-2/5 rounded" />
          </div>
        ))}
      </div>
      <div className="card mt-7 space-y-3 p-5">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-4">
            <span className="skeleton size-9 rounded-lg" />
            <span className="flex-1 space-y-2">
              <span className="skeleton block h-3 w-2/5 rounded" />
              <span className="skeleton block h-2.5 w-3/5 rounded" />
            </span>
            <span className="skeleton h-6 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
