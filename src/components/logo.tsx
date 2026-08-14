import Link from "next/link";

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
      className="inline-flex items-center gap-2.5"
      aria-label="Valmont Agent home"
    >
      <span
        className={`flex size-8 items-center justify-center rounded-[9px] text-[15px] font-extrabold ${inverse ? "bg-white text-[#174f3c]" : "bg-[#174f3c] text-white"}`}
      >
        V
      </span>
      <span
        className={`text-[15px] font-bold tracking-[-0.01em] ${inverse ? "text-white" : "text-[#14211d]"}`}
      >
        Valmont Agent
      </span>
    </Link>
  );
}
