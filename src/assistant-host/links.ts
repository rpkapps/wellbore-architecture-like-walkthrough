/*
 * The `app://` links an answer may contain, parsed (pressing one runs in `host.ts`).
 */

/** The input of an `app://action/<id>?…` link: URL-encoded JSON, `input=<json>`, or plain key=value pairs. */
export function linkInput(query: string): Record<string, unknown> | undefined {
  if (!query) return undefined;
  const raw = decodeURIComponent(query.replace(/\+/g, ' '));
  if (raw.trim().startsWith('{')) return JSON.parse(raw) as Record<string, unknown>;
  const params = new URLSearchParams(query);
  const input = params.get('input');
  if (input) return JSON.parse(input) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of params) out[k] = v === 'true' ? true : v === 'false' ? false : v !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
  return out;
}

/** Parses an `app://kind/target?query` link. */
export function parseAppLink(href: string): { kind: string; target: string; query: string } | null {
  const m = /^app:\/\/([^/?#]+)\/?([^?#]*)(?:\?([^#]*))?/i.exec(href.trim());
  return m ? { kind: m[1].toLowerCase(), target: decodeURIComponent(m[2]), query: m[3] ?? '' } : null;
}
