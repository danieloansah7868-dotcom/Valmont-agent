"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { apiMutation } from "@/lib/client-api";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className="btn-quiet size-9 min-h-9 px-0"
      aria-label="Sign out"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await apiMutation("/api/auth/signout", {});
          router.push("/");
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? (
        <span className="spinner spinner-brand" aria-hidden="true" />
      ) : (
        <LogOut className="size-[17px]" aria-hidden="true" />
      )}
    </button>
  );
}
