export type CustomPropertyType = "text" | "number" | "datetime";

export interface CustomProperty {
  id: string;
  name: string;
  type: CustomPropertyType;
  value: string;
}

export interface DocumentMeta {
  title: string;
  tags: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  customProperties: CustomProperty[];
}

export function createDocumentMeta(): DocumentMeta {
  const now = new Date().toISOString();
  return { title: "", tags: [], author: "", createdAt: now, updatedAt: now, customProperties: [] };
}

// Returns a copy of `meta` with `updatedAt` refreshed; call on any edit.
export function touch(meta: DocumentMeta): DocumentMeta {
  return { ...meta, updatedAt: new Date().toISOString() };
}
