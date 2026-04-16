// Escapes characters that are special in XML attribute values and text content.
// Used by CoT and KML serialisers to prevent injection in generated markup.
export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
