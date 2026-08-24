import { redirect } from "next/navigation";

/** The root of Valmont Agent is the private agency workspace. */
export default function HomePage() {
  redirect("/dashboard");
}
