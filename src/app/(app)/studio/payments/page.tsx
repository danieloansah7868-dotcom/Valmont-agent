import Link from "next/link";
import { requireSessionUser } from "@/lib/auth";
import { publicPaymentSettings } from "@/lib/studio/payment-settings";
import { PaymentSettingsForm } from "@/components/studio/payment-settings-form";

export const dynamic = "force-dynamic";

export default async function StudioPaymentsPage() {
  await requireSessionUser();
  return (
    <main className="mx-auto w-full max-w-[760px] p-4 sm:p-6">
      <Link
        href="/studio"
        className="text-sm font-semibold text-brandblue underline"
      >
        ← Back to Website Studio
      </Link>
      <h1 className="mt-4 text-2xl font-bold text-navy">Valmont Pay</h1>
      <p className="mt-2 text-sm text-slate-600">
        Connect the Valmont Pay account where your customer payments will
        settle. Keep Test mode on while setting it up. Money becomes real only
        after all three details are set and you deliberately choose Live mode.
      </p>
      <PaymentSettingsForm initial={publicPaymentSettings()} />
    </main>
  );
}
