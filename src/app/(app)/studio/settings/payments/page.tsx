import Link from "next/link";
import { requireSessionUser } from "@/lib/auth";
import { paymentSettingsStatus } from "@/lib/studio/payment-settings";
import { PaymentSettingsForm } from "@/components/studio/payment-settings-form";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Payment settings — Website Studio",
};

/**
 * Studio → Settings → Payments.
 *
 * Where the merchant connects a real Valmont Pay account. Everything here is
 * written in plain English for a non-technical owner: what to ask Valmont Pay
 * for, where to paste it, and exactly when money becomes real.
 */
export default async function PaymentSettingsPage() {
  const user = await requireSessionUser();
  const status = await paymentSettingsStatus(user);

  return (
    <div className="mx-auto w-full max-w-[760px] p-4 sm:p-6">
      <p className="text-xs text-slate-500">
        <Link href="/studio" className="underline">
          Website Studio
        </Link>{" "}
        → Settings → Payments
      </p>
      <h1 className="mt-2 text-2xl font-bold text-navy">Payment settings</h1>

      <div
        className={`mt-4 rounded-xl border p-4 ${
          status.liveActive
            ? "border-red-300 bg-red-50"
            : "border-amber-300 bg-amber-50"
        }`}
        data-testid="mode-banner"
      >
        {status.liveActive ? (
          <p className="text-sm font-semibold text-red-800">
            LIVE — customer payments charge real Mobile Money and bank cards.
          </p>
        ) : status.mode === "live" ? (
          <p className="text-sm font-semibold text-amber-900">
            Live mode is selected, but payments still run in test mode because
            some Valmont Pay details are missing. See the yellow notes below.
          </p>
        ) : (
          <p className="text-sm font-semibold text-amber-900">
            Test mode — payments are pretend. No real money moves, so you can
            practise safely.
          </p>
        )}
      </div>

      <section
        className="mt-6 rounded-xl border border-line bg-white p-5"
        aria-labelledby="how-this-works"
      >
        <h2 id="how-this-works" className="text-lg font-semibold text-navy">
          How this works, in plain English
        </h2>
        <ol className="mt-3 grid list-decimal gap-2 pl-5 text-sm text-slate">
          <li>
            Ask Valmont Pay for three things: your{" "}
            <strong>API website address</strong> (it starts with https://), your{" "}
            <strong>secret key</strong>, and your{" "}
            <strong>webhook signing secret</strong>.
          </li>
          <li>Paste each one into the matching box below and press Save.</li>
          <li>
            Keep <strong>Test mode</strong> on while you practise. In Test mode
            every payment uses the built-in pretend payment page — even with
            real details saved — so nothing can charge a customer by accident.
          </li>
          <li>
            When you are ready for real money, choose <strong>Live mode</strong>{" "}
            and Save. From that moment, customers pay with real MTN MoMo,
            Telecel Cash, AirtelTigo, Visa/Mastercard or bank transfer.
          </li>
        </ol>
        <p className="mt-3 rounded-md bg-ivory p-2 text-xs text-slate-600">
          Your secrets are stored encrypted on this server and are never shown
          on any screen again — not even here. Each box only ever says SET or
          NOT SET. To change one, paste a new value over it.
        </p>
      </section>

      <PaymentSettingsForm initialStatus={status} />

      <section
        className="mt-6 rounded-xl border border-line bg-white p-5"
        aria-labelledby="webhook-explainer"
      >
        <h2 id="webhook-explainer" className="text-lg font-semibold text-navy">
          How we know a customer really paid
        </h2>
        <p className="mt-2 text-sm text-slate">
          After a customer pays, Valmont Pay sends this website a private
          confirmation message (a “webhook”), signed with your webhook signing
          secret. This website checks that signature before it marks any order
          as Paid. An unsigned or wrongly-signed message is refused — so nobody
          can fake a payment.
        </p>
        <p className="mt-2 text-sm text-slate">
          You do not need to copy any address for this: the website tells
          Valmont Pay where to send the confirmation automatically each time a
          customer checks out.
        </p>
      </section>
    </div>
  );
}
