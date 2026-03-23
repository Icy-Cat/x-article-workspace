export interface XArticleSettings {
  locale: "auto" | "en" | "zh-CN";
  playwrightToken: string;
  enableDebugLog: boolean;
  autoRefresh: boolean;
  autoApplyCover: boolean;
  stripFrontmatter: boolean;
  useFilenameAsTitle: boolean;
  showDraftNotice: boolean;
  showWelcomeGuide: boolean;
}

export const DEFAULT_SETTINGS: XArticleSettings = {
  locale: "auto",
  playwrightToken: "",
  enableDebugLog: false,
  autoRefresh: true,
  autoApplyCover: true,
  stripFrontmatter: true,
  useFilenameAsTitle: false,
  showDraftNotice: true,
  showWelcomeGuide: true
};

export interface FrontmatterInfo {
  data: Record<string, unknown>;
  body: string;
  title: string | null;
  cover: string | null;
}

export interface PreviewMetadata {
  title: string;
  summary: string;
  cover: string | null;
  frontmatter: FrontmatterInfo;
  markdown: string;
}

export type PublishItem =
  | { type: "code"; marker: string; language: string; code: string }
  | { type: "post"; marker: string; url: string }
  | { type: "divider"; marker: string }
  | { type: "image"; marker: string; alt: string; fileName: string; mimeType: string; base64: string };

export type PublishImageAsset = Omit<Extract<PublishItem, { type: "image" }>, "type" | "marker">;

export interface PublishPayload {
  html: string;
  markdown: string;
  items: PublishItem[];
  title: string | null;
  cover: PublishImageAsset | null;
  autoApplyCover: boolean;
}
