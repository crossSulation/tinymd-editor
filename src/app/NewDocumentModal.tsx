import { useState, type FormEvent, type KeyboardEvent } from "react";
import "./new-document-modal.css";

export interface NewDocumentFields {
  title: string;
  author: string;
  tags: string[];
}

export interface NewDocumentModalProps {
  onCreate: (fields: NewDocumentFields) => void;
  onCancel: () => void;
}

// Title/author/tags are captured here, once, at creation time -- there is no
// metadata-editing UI anywhere else in the app (see Claude.md's Persistence
// section for why DocumentHeader was removed in favor of this).
export function NewDocumentModal({ onCreate, onCancel }: NewDocumentModalProps) {
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");

  function addTag() {
    const tag = tagDraft.trim();
    setTagDraft("");
    if (!tag || tags.includes(tag)) return;
    setTags((prev) => [...prev, tag]);
  }

  function removeTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag));
  }

  function handleTagKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      addTag();
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onCreate({ title: title.trim(), author: author.trim(), tags });
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal-card" onClick={(event) => event.stopPropagation()} onSubmit={handleSubmit}>
        <h2 className="modal-title">New document</h2>

        <label className="modal-field">
          <span className="modal-field-label">Title</span>
          <input
            autoFocus
            className="modal-input"
            placeholder="Untitled"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className="modal-field">
          <span className="modal-field-label">Author</span>
          <input className="modal-input" value={author} onChange={(event) => setAuthor(event.target.value)} />
        </label>

        <div className="modal-field">
          <span className="modal-field-label">Tags</span>
          <div className="modal-tags">
            {tags.map((tag) => (
              <span className="modal-tag" key={tag}>
                {tag}
                <button type="button" onClick={() => removeTag(tag)} aria-label={`Remove tag ${tag}`}>
                  ×
                </button>
              </span>
            ))}
            <input
              className="modal-tag-input"
              placeholder="Add tag"
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={handleTagKeyDown}
              onBlur={addTag}
            />
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" className="modal-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="modal-submit">
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
