"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  FolderPlus,
  Lock,
  Unlock,
} from "lucide-react";
import { apiMutation } from "@/lib/client-api";
import type { RepositorySummary } from "@/lib/types";

export function CreateRepositoryForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<RepositorySummary | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    setCreated(null);
    try {
      const response = await apiMutation<{ repository: RepositorySummary }>(
        "/api/repositories",
        {
          name,
          description: description.trim() || undefined,
          visibility,
        },
      );
      setCreated(response.repository);
      setName("");
      setDescription("");
      setVisibility("private");
      router.refresh();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The repository could not be created.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section id="create-repository" className="card mt-7 overflow-hidden">
      <div className="border-b border-line bg-ivory-50 px-5 py-4 sm:px-6">
        <div className="flex gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brandblue-50 text-brandblue">
            <FolderPlus className="size-[18px]" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-[13px] font-bold text-navy">
              Create a GitHub repository
            </h2>
            <p className="mt-1 text-[10px] leading-4 text-slate">
              Choose the name and visibility. Valmont initializes a README on
              the default branch so the repository is ready for chat and coding
              tasks.
            </p>
          </div>
        </div>
      </div>

      <form onSubmit={submit} className="p-5 sm:p-6">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <label>
            <span className="label">Repository name</span>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={1}
              maxLength={100}
              pattern="[A-Za-z0-9_.-]+"
              title="Use letters, numbers, periods, hyphens, or underscores"
              placeholder="my-new-project"
              autoComplete="off"
              required
            />
          </label>
          <label>
            <span className="label">Description</span>
            <input
              className="input"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={350}
              placeholder="Optional short description"
            />
          </label>
        </div>

        <fieldset className="mt-5">
          <legend className="label">Visibility</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <VisibilityOption
              checked={visibility === "private"}
              description="Only you and people you grant access can see it."
              icon={Lock}
              label="Private"
              onChange={() => setVisibility("private")}
              value="private"
            />
            <VisibilityOption
              checked={visibility === "public"}
              description="Anyone on the internet can see it."
              icon={Unlock}
              label="Public"
              onChange={() => setVisibility("public")}
              value="public"
            />
          </div>
          {visibility === "public" ? (
            <p
              className="mt-3 rounded-lg border border-attention/25 bg-attention-soft px-3 py-2 text-[10px] leading-4 text-navy"
              role="alert"
            >
              Public repositories are visible to everyone immediately after
              creation. Choose Private if the project may contain confidential
              work.
            </p>
          ) : null}
        </fieldset>

        {error ? (
          <p
            className="mt-4 rounded-lg border border-fail/20 bg-fail/5 px-3 py-2 text-[11px] text-fail"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        {created ? (
          <div
            className="mt-4 flex flex-col gap-3 rounded-xl border border-pass/20 bg-pass/5 px-4 py-3 sm:flex-row sm:items-center"
            role="status"
          >
            <CheckCircle2
              className="size-5 shrink-0 text-pass"
              aria-hidden="true"
            />
            <p className="min-w-0 flex-1 text-[11px] text-slate">
              <strong className="text-navy">{created.fullName}</strong> was
              created as a {created.private ? "private" : "public"} repository.
            </p>
            <div className="flex gap-2">
              <a
                href={`https://github.com/${created.fullName
                  .split("/")
                  .map(encodeURIComponent)
                  .join("/")}`}
                target="_blank"
                rel="noreferrer"
                className="btn-quiet min-h-8 px-2.5 text-[10px]"
              >
                GitHub <ExternalLink className="size-3" aria-hidden="true" />
              </a>
              <Link
                href={`/tasks/new?repository=${encodeURIComponent(created.id)}`}
                className="btn-secondary min-h-8 px-2.5 text-[10px]"
              >
                New task
              </Link>
            </div>
          </div>
        ) : null}

        <div className="mt-5 flex flex-col-reverse gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[10px] leading-4 text-slate">
            Repository creation happens immediately after this explicit action.
            Valmont has no repository deletion or settings-editing capability.
          </p>
          <button
            type="submit"
            className="btn-primary shrink-0"
            disabled={submitting || !name.trim()}
          >
            {submitting ? (
              <>
                <span className="spinner" aria-hidden="true" /> Creating…
              </>
            ) : (
              <>
                <FolderPlus className="size-4" aria-hidden="true" /> Create
                repository
              </>
            )}
          </button>
        </div>
      </form>
    </section>
  );
}

function VisibilityOption({
  checked,
  description,
  icon: Icon,
  label,
  onChange,
  value,
}: {
  checked: boolean;
  description: string;
  icon: typeof Lock;
  label: string;
  onChange: () => void;
  value: "private" | "public";
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-xl border p-3.5 transition-colors ${
        checked
          ? "border-brandblue-200 bg-brandblue-50"
          : "border-line bg-white hover:bg-ivory-50"
      }`}
    >
      <input
        type="radio"
        name="visibility"
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-1 accent-brandblue"
      />
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${checked ? "text-brandblue" : "text-slate"}`}
        aria-hidden="true"
      />
      <span>
        <span className="block text-[11px] font-bold text-navy">{label}</span>
        <span className="mt-1 block text-[10px] leading-4 text-slate">
          {description}
        </span>
      </span>
    </label>
  );
}
