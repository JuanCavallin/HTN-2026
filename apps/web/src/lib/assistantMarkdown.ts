/**
 * Repair the common "Markdown in one long line" shape produced by some model providers.
 *
 * This deliberately targets strong structural signals instead of attempting to rewrite prose.
 * Well-formed Markdown is left alone, while headings, numbered records, labelled metadata and
 * bold action bullets are given the line boundaries a Markdown parser needs.
 */
export function normalizeAssistantMarkdown(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/[ \t]*---[ \t]*(?=#{1,6}\s)/g, '\n\n---\n\n')
    .replace(/([^\n])\s+(?=#{1,6}\s)/g, '$1\n\n')
    .replace(/\s+(?=\d+\.\s+\*\*)/g, '\n\n')
    .replace(
      /\s+-\s+(?=(?:received|summary|note|organizer|location|date|time|from|subject|attendees?|action|status):)/gi,
      '\n   - ',
    )
    .replace(/\s+-\s+(?=\*\*)/g, '\n- ')
    .replace(/\s+(?=Let me know\b)/gi, '\n\n')
    .replace(/\n{3,}/g, '\n\n');
}
