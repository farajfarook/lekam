/** Best-effort Markdown -> Slack mrkdwn. Agents drift back to GitHub Markdown; Slack renders none of it. */
export function toMrkdwn(input) {
  if (!input) return input;
  const out = [];
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line.trim()); continue; }
    if (inFence) { out.push(line); continue; }
    // table separator rows vanish
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue;
    // table rows -> bullets: "| a | b | c |" -> "- a · b · c"; header row (first in a block) becomes bold
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim()).filter((c, idx, arr) => !(idx === arr.length - 1 && c === ''));
      const isHeader = /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '');
      line = isHeader ? `*${cells.join(' · ')}*` : `- ${cells.join(' · ')}`;
      out.push(inline(line));
      continue;
    }
    line = line.replace(/^\s*#{1,6}\s+(.*?)\s*#*\s*$/, (_, t) => `*${t}*`); // headings
    line = line.replace(/^(\s*)[*+]\s+/, '$1- '); // bullets
    out.push(inline(line));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function inline(s) {
  return s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>') // links
    .replace(/(?<![*\w])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![*\w])/g, '*$1*') // **bold**
    .replace(/(?<![*\w])__(?=\S)(.+?)(?<=\S)__(?![*\w])/g, '_$1_') // __italic__
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '~$1~'); // strike
}
