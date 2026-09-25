import { z } from 'zod';
import { Signal } from '../ui/signal';

/**
 * The user's own formats, kept in this browser. A custom format is either
 * declarative — a built-in codec with its options plus the steps that make
 * the data usable (a regex for a vendor's text feed, a JSON path and a
 * column mapping for an API) — or a code plugin: an ES module URL whose
 * codecs, steps and transports register like the built-in ones.
 */
export const FormatPreset = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  description: z.string().default(''),
  format: z.object({ id: z.string(), options: z.unknown().default({}) }),
  steps: z.array(z.object({ id: z.string(), options: z.unknown().default({}), enabled: z.boolean().default(true) })).default([]),
  plugins: z.array(z.string()).default([]),
});
export type FormatPreset = z.output<typeof FormatPreset>;

const FORMATS_KEY = 'bw.formats.v1';
const PLUGINS_KEY = 'bw.plugins.v1';

function load<T>(key: string, schema: z.ZodType<T>): T[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[];
    return raw.flatMap((r) => {
      const p = schema.safeParse(r);
      return p.success ? [p.data] : [];
    });
  } catch {
    return [];
  }
}
function store(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked: kept for this session */
  }
}

export const formatPresets = new Signal<FormatPreset[]>(typeof localStorage === 'undefined' ? [] : load(FORMATS_KEY, FormatPreset));
/** module URLs of code plugins the user added */
export const pluginModules = new Signal<string[]>(typeof localStorage === 'undefined' ? [] : load(PLUGINS_KEY, z.string().url()));

export function saveFormat(p: Omit<FormatPreset, 'id'> & { id?: string }): FormatPreset {
  const preset = FormatPreset.parse({ ...p, id: p.id ?? `f${Date.now().toString(36)}` });
  const list = formatPresets.value.filter((x) => x.id !== preset.id && x.name !== preset.name);
  formatPresets.set([...list, preset]);
  store(FORMATS_KEY, formatPresets.value);
  return preset;
}

export function removeFormat(id: string) {
  formatPresets.set(formatPresets.value.filter((x) => x.id !== id));
  store(FORMATS_KEY, formatPresets.value);
}

export function addPlugin(url: string) {
  if (!pluginModules.value.includes(url)) pluginModules.set([...pluginModules.value, url]);
  store(PLUGINS_KEY, pluginModules.value);
}

export function removePlugin(url: string) {
  pluginModules.set(pluginModules.value.filter((u) => u !== url));
  store(PLUGINS_KEY, pluginModules.value);
}
