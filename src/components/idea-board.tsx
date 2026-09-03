"use client";

import { FormEvent, useMemo, useState } from "react";
import { Pencil, Search, Trash2, X } from "lucide-react";
import { apiDelete, apiMutation, apiPatch, ApiError } from "@/lib/client-api";
import type { IdeaPriority, IdeaRecord, IdeaStatus } from "@/lib/idea-store";

const STATUS_ORDER: IdeaStatus[] = [
  "building",
  "planned",
  "idea",
  "done",
  "dropped",
];

const STATUS_LABELS: Record<IdeaStatus, string> = {
  building: "Building",
  planned: "Planned",
  idea: "Ideas",
  done: "Done",
  dropped: "Dropped",
};

const PRIORITY_LABELS: Record<IdeaPriority, string> = {
  1: "Now",
  2: "Soon",
  3: "Later",
};

const PRIORITY_PILL: Record<IdeaPriority, string> = {
  1: "bg-copper/10 text-copper",
  2: "bg-brandblue-50 text-brandblue",
  3: "bg-navy/5 text-slate",
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

type IdeaFormState = {
  title: string;
  details: string;
  priority: IdeaPriority;
};

const emptyForm: IdeaFormState = { title: "", details: "", priority: 2 };

export function IdeaBoard({ initialIdeas }: { initialIdeas: IdeaRecord[] }) {
  const [ideas, setIdeas] = useState<IdeaRecord[]>(initialIdeas);
  const [form, setForm] = useState<IdeaFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<IdeaFormState>(emptyForm);
  const [editError, setEditError] = useState("");

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return ideas;
    return ideas.filter(
      (idea) =>
        idea.title.toLowerCase().includes(query) ||
        idea.details.toLowerCase().includes(query),
    );
  }, [ideas, search]);

  const grouped = useMemo(() => {
    const map = new Map<IdeaStatus, IdeaRecord[]>();
    for (const status of STATUS_ORDER) map.set(status, []);
    for (const idea of filtered) {
      map.get(idea.status)?.push(idea);
    }
    return map;
  }, [filtered]);

  async function saveIdea(event: FormEvent) {
    event.preventDefault();
    const title = form.title.trim();
    if (!title || saving) return;
    setError("");
    setSaving(true);
    // Optimistic: appear at the top of the list immediately; the server
    // response replaces the placeholder so ordering follows updated_at.
    const placeholder: IdeaRecord = {
      id: `pending-${Date.now()}`,
      userId: "",
      title,
      details: form.details.trim(),
      status: "idea",
      priority: form.priority,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setIdeas((current) => [placeholder, ...current]);
    setForm(emptyForm);
    try {
      const created = await apiMutation<{ idea: IdeaRecord }>("/api/ideas", {
        title,
        details: form.details.trim(),
        priority: form.priority,
      });
      setIdeas((current) =>
        current.map((idea) =>
          idea.id === placeholder.id ? created.idea : idea,
        ),
      );
    } catch (requestError) {
      setIdeas((current) =>
        current.filter((idea) => idea.id !== placeholder.id),
      );
      setForm({ title, details: form.details, priority: form.priority });
      setError(
        requestError instanceof ApiError
          ? requestError.message
          : "Could not save the idea.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(idea: IdeaRecord, status: IdeaStatus) {
    if (status === idea.status) return;
    const previous = ideas;
    setIdeas((current) =>
      current.map((item) => (item.id === idea.id ? { ...item, status } : item)),
    );
    try {
      const updated = await apiPatch<{ idea: IdeaRecord }>(
        `/api/ideas/${idea.id}`,
        { status },
      );
      setIdeas((current) =>
        current.map((item) => (item.id === idea.id ? updated.idea : item)),
      );
    } catch (requestError) {
      setIdeas(previous);
      setError(
        requestError instanceof ApiError
          ? requestError.message
          : "Could not update the idea.",
      );
    }
  }

  function startEdit(idea: IdeaRecord) {
    setEditingId(idea.id);
    setEditError("");
    setEditForm({
      title: idea.title,
      details: idea.details,
      priority: idea.priority,
    });
  }

  async function saveEdit(idea: IdeaRecord) {
    const title = editForm.title.trim();
    if (!title) {
      setEditError("Title cannot be empty.");
      return;
    }
    setEditError("");
    try {
      const updated = await apiPatch<{ idea: IdeaRecord }>(
        `/api/ideas/${idea.id}`,
        {
          title,
          details: editForm.details.trim(),
          priority: editForm.priority,
        },
      );
      setIdeas((current) =>
        current.map((item) => (item.id === idea.id ? updated.idea : item)),
      );
      setEditingId(null);
    } catch (requestError) {
      setEditError(
        requestError instanceof ApiError
          ? requestError.message
          : "Could not save the edit.",
      );
    }
  }

  async function removeIdea(idea: IdeaRecord) {
    if (!confirm(`Delete "${idea.title}"? This cannot be undone.`)) return;
    try {
      await apiDelete(`/api/ideas/${idea.id}`);
      setIdeas((current) => current.filter((item) => item.id !== idea.id));
    } catch (requestError) {
      setError(
        requestError instanceof ApiError
          ? requestError.message
          : "Could not delete the idea.",
      );
    }
  }

  return (
    <>
      <form
        data-testid="idea-form"
        onSubmit={saveIdea}
        className="card mt-6 space-y-3 p-5"
      >
        <div>
          <label
            htmlFor="idea-title"
            className="text-[11px] font-bold text-navy"
          >
            Title
          </label>
          <input
            id="idea-title"
            data-testid="idea-title"
            className="input mt-1 w-full"
            type="text"
            maxLength={120}
            placeholder="What is the idea?"
            value={form.title}
            onChange={(event) =>
              setForm((current) => ({ ...current, title: event.target.value }))
            }
          />
        </div>
        <div>
          <label
            htmlFor="idea-details"
            className="text-[11px] font-bold text-navy"
          >
            Details
          </label>
          <textarea
            id="idea-details"
            data-testid="idea-details"
            className="textarea mt-1 w-full"
            rows={4}
            maxLength={4000}
            placeholder="Why it matters, what it depends on, anything to remember."
            value={form.details}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                details: event.target.value,
              }))
            }
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="idea-priority"
              className="text-[11px] font-bold text-navy"
            >
              Priority
            </label>
            <select
              id="idea-priority"
              data-testid="idea-priority"
              className="select mt-1"
              value={form.priority}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  priority: Number(event.target.value) as IdeaPriority,
                }))
              }
            >
              <option value={1}>Now</option>
              <option value={2}>Soon</option>
              <option value={3}>Later</option>
            </select>
          </div>
          <button
            type="submit"
            data-testid="idea-save"
            className="btn-primary"
            disabled={saving || !form.title.trim()}
          >
            {saving ? "Saving…" : "Save idea"}
          </button>
        </div>
      </form>

      {error ? (
        <p className="mt-3 text-[11px] text-fail" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-6">
        <div className="relative max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate"
            aria-hidden="true"
          />
          <input
            data-testid="idea-search"
            className="input w-full pl-9"
            type="search"
            placeholder="Search ideas…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search ideas"
          />
        </div>
      </div>

      {ideas.length === 0 ? (
        <p className="card mt-6 px-5 py-8 text-center text-[12px] text-slate">
          No ideas yet. Write the first one above.
        </p>
      ) : filtered.length === 0 ? (
        <p className="card mt-6 px-5 py-8 text-center text-[12px] text-slate">
          No ideas match your search.
        </p>
      ) : (
        <div className="mt-6 space-y-7">
          {STATUS_ORDER.map((status) => {
            const cards = grouped.get(status) ?? [];
            if (cards.length === 0) return null;
            return (
              <section key={status}>
                <h2 className="mb-2 text-[11px] font-bold tracking-[0.14em] text-slate uppercase">
                  {STATUS_LABELS[status]}{" "}
                  <span className="text-slate/60">{cards.length}</span>
                </h2>
                <ul className="space-y-3">
                  {cards.map((idea) => (
                    <li
                      key={idea.id}
                      data-testid={`idea-card-${idea.id}`}
                      className="card p-4 sm:p-5"
                    >
                      {editingId === idea.id ? (
                        <div className="space-y-3">
                          <input
                            className="input w-full"
                            type="text"
                            maxLength={120}
                            aria-label="Edit idea title"
                            value={editForm.title}
                            onChange={(event) =>
                              setEditForm((current) => ({
                                ...current,
                                title: event.target.value,
                              }))
                            }
                          />
                          <textarea
                            className="textarea w-full"
                            rows={4}
                            maxLength={4000}
                            aria-label="Edit idea details"
                            value={editForm.details}
                            onChange={(event) =>
                              setEditForm((current) => ({
                                ...current,
                                details: event.target.value,
                              }))
                            }
                          />
                          <div className="flex flex-wrap items-end gap-3">
                            <div>
                              <label
                                htmlFor={`idea-edit-priority-${idea.id}`}
                                className="text-[11px] font-bold text-navy"
                              >
                                Priority
                              </label>
                              <select
                                id={`idea-edit-priority-${idea.id}`}
                                className="select mt-1"
                                aria-label="Edit idea priority"
                                value={editForm.priority}
                                onChange={(event) =>
                                  setEditForm((current) => ({
                                    ...current,
                                    priority: Number(
                                      event.target.value,
                                    ) as IdeaPriority,
                                  }))
                                }
                              >
                                <option value={1}>Now</option>
                                <option value={2}>Soon</option>
                                <option value={3}>Later</option>
                              </select>
                            </div>
                            <button
                              type="button"
                              className="btn-primary"
                              onClick={() => void saveEdit(idea)}
                            >
                              Save changes
                            </button>
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => setEditingId(null)}
                            >
                              <X className="size-3.5" aria-hidden="true" />
                              Cancel
                            </button>
                          </div>
                          {editError ? (
                            <p className="text-[11px] text-fail" role="alert">
                              {editError}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <>
                          <div className="flex items-start justify-between gap-3">
                            <h3 className="text-[14px] font-bold text-navy">
                              {idea.title}
                            </h3>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${PRIORITY_PILL[idea.priority]}`}
                            >
                              {PRIORITY_LABELS[idea.priority]}
                            </span>
                          </div>
                          {idea.details ? (
                            <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-6 text-slate">
                              {idea.details}
                            </p>
                          ) : null}
                          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3">
                            <span className="text-[11px] text-slate">
                              {formatDate(idea.updatedAt)}
                            </span>
                            <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate">
                              Status
                              <select
                                data-testid={`idea-status-${idea.id}`}
                                className="select min-h-8 py-1 text-[11px]"
                                value={idea.status}
                                onChange={(event) =>
                                  void changeStatus(
                                    idea,
                                    event.target.value as IdeaStatus,
                                  )
                                }
                                aria-label={`Change status of ${idea.title}`}
                              >
                                {STATUS_ORDER.map((status) => (
                                  <option key={status} value={status}>
                                    {STATUS_LABELS[status]}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <div className="ml-auto flex gap-1">
                              <button
                                type="button"
                                data-testid={`idea-edit-${idea.id}`}
                                className="btn-quiet size-8 min-h-8 px-0"
                                onClick={() => startEdit(idea)}
                                aria-label={`Edit ${idea.title}`}
                              >
                                <Pencil
                                  className="size-3.5"
                                  aria-hidden="true"
                                />
                              </button>
                              <button
                                type="button"
                                data-testid={`idea-delete-${idea.id}`}
                                className="btn-quiet size-8 min-h-8 px-0 text-fail"
                                onClick={() => void removeIdea(idea)}
                                aria-label={`Delete ${idea.title}`}
                              >
                                <Trash2
                                  className="size-3.5"
                                  aria-hidden="true"
                                />
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
