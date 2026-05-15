const PATTERNS = [
  /^#{1,6}\s+\S/m,
  /^>\s+\S/m,
  /^[-*+]\s+\S/m,
  /^\d+\.\s+\S/m,
  /^\s*```/m,
  /^\s*---\s*$/m,
  /!\[[^\]]*\]\((https?:|data:)/,
  /\[[^\]]+\]\(https?:\/\/\S+\)/,
  /^\s*\|.+\|\s*$\n^\s*\|[\s:|\-]+\|\s*$/m,
  /`[^`\n]+`/,
];

export function isMarkdown(text) {
  if (!text || text.length < 3) return false;
  let hits = 0;
  for (const re of PATTERNS) {
    if (re.test(text)) hits++;
    if (hits >= 1) return true;
  }
  return false;
}
