export function formatAccra(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Accra" });
}
