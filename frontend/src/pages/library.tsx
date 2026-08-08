import { useEffect, useState, type ReactElement } from "react";
import { toast } from "sonner";
import {
  useCreateLibraryItem,
  useDeleteLibraryItem,
  useLibraryItems,
  useUpdateLibraryItem,
  type LibraryItem,
} from "../lib/api";
import { Shell } from "../components/layout/shell";
import { formatCount } from "../lib/format-helpers";
import styles from "./library.module.css";

const MAX_BODY_BYTES = 64 * 1024;
const SEARCH_DEBOUNCE_MS = 200;

function tagsToText(tags: string[]): string {
  return tags.join(", ");
}

function textToTags(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function bodyByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function LibraryPage(): ReactElement {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setQuery(queryInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [queryInput]);

  const items = useLibraryItems(query, tagFilter ?? undefined);

  const [activeId, setActiveId] = useState<number | "new" | null>(null);

  const list = items.data?.items ?? [];

  const active: LibraryItem | null =
    typeof activeId === "number"
      ? (list.find((i) => i.id === activeId) ?? null)
      : null;

  return (
    <Shell>
      <div className={styles.page}>
        <div className={styles.left}>
          <input
            className={styles.search}
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="Search title/body…"
            aria-label="Search library"
          />
          {tagFilter ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnGhost}`}
              onClick={() => setTagFilter(null)}
              aria-label={`Clear tag filter ${tagFilter}`}
            >
              tag: {tagFilter} ×
            </button>
          ) : null}
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={() => setActiveId("new")}
          >
            + New item
          </button>
          <div className={styles.list} role="listbox">
            {items.isPending ? (
              <div className={styles.empty}>Loading…</div>
            ) : list.length === 0 ? (
              <div className={styles.empty}>
                No items yet — create one above.
              </div>
            ) : (
              list.map((it) => (
                <div
                  key={it.id}
                  role="option"
                  aria-selected={activeId === it.id}
                  className={`${styles.row} ${activeId === it.id ? styles.rowActive : ""}`}
                  onClick={() => setActiveId(it.id)}
                >
                  <span className={styles.title}>{it.title}</span>
                  <span className={styles.slug}>@library:{it.slug}</span>
                  {it.tags.length > 0 ? (
                    <span className={styles.tagsRow}>
                      {it.tags.map((t) => (
                        <button
                          key={t}
                          type="button"
                          className={styles.tagChip}
                          onClick={(e) => {
                            e.stopPropagation();
                            setTagFilter(t);
                          }}
                          aria-label={`Filter by tag ${t}`}
                        >
                          {t}
                        </button>
                      ))}
                    </span>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>

        <div className={styles.right}>
          {activeId === null ? (
            <div className={styles.empty}>
              Pick an item from the list, or create a new one. Reference any
              item in the omni-bar with <code>@library:&lt;slug&gt;</code>.
            </div>
          ) : (
            <LibraryEditor
              key={activeId}
              item={active}
              onClose={() => setActiveId(null)}
              onCreated={(id) => setActiveId(id)}
            />
          )}
        </div>
      </div>
    </Shell>
  );
}

function LibraryEditor({
  item,
  onClose,
  onCreated,
}: {
  item: LibraryItem | null;
  onClose: () => void;
  onCreated: (id: number) => void;
}): ReactElement {
  const create = useCreateLibraryItem();
  const update = useUpdateLibraryItem();
  const remove = useDeleteLibraryItem();

  const isNew = item === null;
  const [slug, setSlug] = useState(item?.slug ?? "");
  const [title, setTitle] = useState(item?.title ?? "");
  const [body, setBody] = useState(item?.body ?? "");
  const [tagsText, setTagsText] = useState(item ? tagsToText(item.tags) : "");

  const bodyBytes = bodyByteLength(body);
  const bodyOverLimit = bodyBytes > MAX_BODY_BYTES;

  function handleSave(): void {
    if (isNew) {
      create.mutate(
        { slug, title, body, tags: textToTags(tagsText) },
        {
          onSuccess: (created) => {
            toast.success(`Created ${created.slug}`);
            onCreated(created.id);
          },
          onError: (e) => toast.error(`Create failed: ${e.message}`),
        },
      );
    } else {
      update.mutate(
        { id: item.id, patch: { title, body, tags: textToTags(tagsText) } },
        {
          onSuccess: () => toast.success(`Saved ${slug}`),
          onError: (e) => toast.error(`Save failed: ${e.message}`),
        },
      );
    }
  }

  function handleDelete(): void {
    if (!item) return;
    if (!confirm(`Delete library item "${slug}"?`)) return;
    remove.mutate(item.id, {
      onSuccess: () => {
        toast.success("Deleted");
        onClose();
      },
      onError: (e) => toast.error(`Delete failed: ${e.message}`),
    });
  }

  return (
    <>
      <div className={styles.field}>
        <label htmlFor="lib-slug">slug</label>
        <input
          id="lib-slug"
          className={styles.input}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          disabled={!isNew}
        />
        <span className={styles.hint}>
          Lowercase letters, digits, _ and - only. Set once on create.
        </span>
      </div>
      <div className={styles.field}>
        <label htmlFor="lib-title">title</label>
        <input
          id="lib-title"
          className={styles.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="lib-tags">tags (comma-separated)</label>
        <input
          id="lib-tags"
          className={styles.input}
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="brand, writing"
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="lib-body">body (markdown)</label>
        <textarea
          id="lib-body"
          className={styles.textarea}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-invalid={bodyOverLimit}
        />
        <span className={styles.hint}>
          {formatCount(bodyBytes)} / {formatCount(MAX_BODY_BYTES)} bytes
          {bodyOverLimit ? " — over limit" : ""}
        </span>
      </div>
      <div className={styles.actions}>
        {!isNew ? (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDanger}`}
            onClick={handleDelete}
            disabled={remove.isPending}
          >
            Delete
          </button>
        ) : null}
        <button
          type="button"
          className={`${styles.btn} ${styles.btnGhost}`}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={handleSave}
          disabled={create.isPending || update.isPending || bodyOverLimit}
        >
          {saveLabel(isNew, create.isPending, update.isPending)}
        </button>
      </div>
    </>
  );
}

function saveLabel(isNew: boolean, creating: boolean, saving: boolean): string {
  if (isNew) return creating ? "Creating…" : "Create";
  return saving ? "Saving…" : "Save";
}
