/*
 * Kit tool names (`view.color_by`) ↔ provider wire names (`view__color_by`):
 * every provider accepts ^[a-zA-Z0-9_-]{1,64}$ and nothing else.
 */

const WIRE = /^[a-zA-Z0-9_-]{1,64}$/;

/** The provider-safe form of a kit name: `.` → `__`, other characters → `_`, at most 64 characters. */
export function sanitizeToolName(name: string): string {
  if (WIRE.test(name)) return name;
  const s = name
    .replace(/\./g, '__')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64);
  return s || 'tool';
}

/** A two-way map for one step's tool set (plus the names that occur in the transcript). */
export interface ToolNameMap {
  toWire: (kitName: string) => string;
  /** the kit name for a wire name the model sent (also accepts the kit name itself), or undefined when unknown */
  toKit: (wireName: string) => string | undefined;
}

/** Builds the map; collisions after sanitising get a numeric suffix (`a_b`, `a_b_2`). */
export function buildToolNameMap(kitNames: Iterable<string>): ToolNameMap {
  const kitToWire = new Map<string, string>();
  const wireToKit = new Map<string, string>();
  const add = (kit: string) => {
    if (kitToWire.has(kit)) return kitToWire.get(kit)!;
    const base = sanitizeToolName(kit);
    let wire = base;
    for (let n = 2; wireToKit.has(wire); n++) {
      const suffix = `_${n}`;
      wire = base.slice(0, 64 - suffix.length) + suffix;
    }
    kitToWire.set(kit, wire);
    wireToKit.set(wire, kit);
    return wire;
  };
  for (const k of kitNames) add(k);
  return {
    toWire: (kit) => add(kit),
    toKit: (wire) => wireToKit.get(wire) ?? (kitToWire.has(wire) ? wire : undefined),
  };
}
