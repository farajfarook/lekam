// Which host has the most room right now, from the host-dispatch skill's capacity script (`--json`).
import { execFile } from 'node:child_process';
import fs from 'node:fs';

/** Pure: the script's JSON -> host name or null. Its own `best` first, else the host with the most free slots. */
export function bestHost(report, names) {
  if (report?.best && names.includes(report.best)) return report.best;
  const open = (report?.hosts ?? []).filter((h) => h.ok && names.includes(h.name) && h.slots > 0).sort((a, b) => b.slots - a.slots);
  return open[0]?.name ?? null;
}

/** Returns an async () => host name | null. No script, or it fails: null (the caller falls back to the first host). */
export function capacityPicker(script, names) {
  return async () => {
    if (!script || !fs.existsSync(script)) return null;
    // Exit 1 means "no host has a slot" and still prints the report.
    const out = await new Promise((resolve) => execFile(process.execPath, [script, '--json'], { timeout: 45e3 }, (_e, stdout) => resolve(stdout)));
    try { return bestHost(JSON.parse(out), names); } catch { return null; }
  };
}
