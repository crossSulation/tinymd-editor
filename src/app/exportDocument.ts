import { loadDoc } from "../control";
import { joinBlocksIntoMarkdown } from "../model";

// Reads the document's stored `blocks` rows directly and rejoins them --
// NOT a round-trip through the Milkdown editor's own markdown serializer.
// The two can differ in incidental formatting (e.g. serializer-chosen list
// markers or emphasis characters), and since `blocks` already holds each
// top-level node's own markdown string (see model/blocks.ts), rejoining
// them is both simpler and exactly what was actually persisted.
export async function exportDocumentAsMarkdown(docId: string): Promise<void> {
  const doc = await loadDoc(docId);
  if (!doc) return;

  const markdown = joinBlocksIntoMarkdown(doc.blocks);
  const filename = `${sanitizeFilename(doc.meta.title) || "untitled"}.md`;

  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function sanitizeFilename(title: string): string {
  return title.trim().replace(/[\\/:*?"<>|]+/g, "_");
}
