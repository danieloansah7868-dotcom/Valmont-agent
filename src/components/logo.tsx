import Link from "next/link";

export function LogoMark({
  className = "size-8",
  inverse = false,
}: {
  className?: string;
  inverse?: boolean;
}) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-[9px] ${className} ${
        inverse ? "bg-ivory" : "bg-navy"
      }`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 64 64" className="size-[62%]" focusable="false">
        <path
          d="M14 15h10.5l7.5 26.5L39.5 15H50L37 49H27L14 15Z"
          fill={inverse ? "#091534" : "#ECE9DE"}
        />
        <path d="M24.5 41.5h15L37 49H27l-2.5-7.5Z" fill="#C26E2E" />
      </svg>
    </span>
  );
}

export function Logo({
  inverse = false,
  href = "/dashboard",
}: {
  inverse?: boolean;
  href?: string;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2.5 rounded-md"
      aria-label="Valmont Agent home"
    >
      <LogoMark inverse={inverse} />
      <span className="leading-none">
        <span
          className={`block text-[15px] font-bold tracking-[-0.01em] ${
            inverse ? "text-ivory" : "text-navy"
          }`}
        >
          Valmont
          <span className="text-copper"> Agent</span>
        </span>
        <span
          className={`mt-1 block text-[9px] font-semibold tracking-[0.14em] uppercase ${
            inverse ? "text-ivory/60" : "text-slate"
          }`}
        >
          Approval-first
        </span>
      </span>
    </Link>
  );
}
