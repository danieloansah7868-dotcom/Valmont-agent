import { OrderAlerts } from "@/components/studio/order-alerts";

export default function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <OrderAlerts />
      {children}
    </>
  );
}
