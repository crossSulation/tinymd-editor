// Model layer: document schema/parsing is owned internally by Crepe's
// Milkdown editor instance. This layer holds data Crepe doesn't know about:
// document metadata, and the markdown <-> blocks mapping used by SQLite
// persistence (see Claude.md).
export type { CustomProperty, CustomPropertyType, DocumentMeta } from "./document";
export { createDocumentMeta, touch } from "./document";
export { joinBlocksIntoMarkdown, splitMarkdownIntoBlocks } from "./blocks";
