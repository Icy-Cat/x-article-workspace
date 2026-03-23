import matter from "gray-matter";
import type { FrontmatterInfo } from "@x-article/shared-types";

export function parseFrontmatter(markdown: string): FrontmatterInfo {
  const parsed = matter(markdown);
  const title = getString(parsed.data, ["title", "Title"]);
  const cover = getString(parsed.data, ["cover", "Cover"]);
  return {
    data: parsed.data,
    body: parsed.content,
    title,
    cover
  };
}

function getString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}
