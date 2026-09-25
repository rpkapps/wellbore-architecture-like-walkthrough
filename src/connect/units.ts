/**
 * Unit conversion for the units a rig, a log or a production system reports
 * in. Each unit is a factor (and offset) to the SI base of its dimension, so
 * any two units of the same dimension convert. Unit spellings vary a lot
 * between vendors ("ohm.m", "OHMM", "ohm-m"), so lookups go through `norm`.
 */
interface U {
  dim: string;
  k: number; // value × k (+ off) = base
  off?: number;
}

const T: Record<string, U> = {};
const def = (dim: string, k: number, names: string[], off = 0) => names.forEach((n) => (T[norm(n)] = { dim, k, off }));

export function norm(u: string): string {
  return u.trim().toLowerCase().replace(/µ|μ/g, 'u').replace(/°/g, 'deg').replace(/³/g, '3').replace(/²/g, '2').replace(/·/g, '.').replace(/\s+/g, '').replace(/[-_*]/g, '.');
}

// length
def('length', 1, ['m', 'metre', 'meter', 'metres', 'meters', 'mtr', 'M']);
def('length', 0.3048, ['ft', 'feet', 'foot', 'f', 'usft', 'ft(us)']);
def('length', 0.0254, ['in', 'inch', 'inches', 'in.']);
def('length', 0.01, ['cm']);
def('length', 0.001, ['mm']);
def('length', 1000, ['km']);
def('length', 0.9144, ['yd']);
// pressure (Pa)
def('pressure', 1, ['pa']);
def('pressure', 1e3, ['kpa']);
def('pressure', 1e6, ['mpa']);
def('pressure', 1e5, ['bar', 'bara', 'barg']);
def('pressure', 6894.757, ['psi', 'psia', 'psig', 'lbf/in2']);
def('pressure', 101325, ['atm']);
// temperature (K)
def('temperature', 1, ['k', 'kelvin']);
def('temperature', 1, ['degc', 'c', 'celsius'], 273.15);
def('temperature', 5 / 9, ['degf', 'f.deg', 'fahrenheit'], 459.67 * (5 / 9));
// density (kg/m3)
def('density', 1, ['kg/m3', 'kgm3']);
def('density', 1000, ['g/cm3', 'g/cc', 'gcc', 'g/ml', 'sg', 'g.cm3', 'kg/l']);
def('density', 119.8264, ['ppg', 'lbm/gal', 'lb/gal', 'lbm/galus']);
def('density', 16.01846, ['lbm/ft3', 'pcf', 'lb/ft3']);
// volume flow (m3/s)
def('flow', 1, ['m3/s']);
def('flow', 1 / 60, ['m3/min']);
def('flow', 1 / 3600, ['m3/h', 'm3/hr']);
def('flow', 1 / 86400, ['m3/d', 'sm3/d', 'm3/day', 'sm3/day']);
def('flow', 1 / 60000, ['l/min', 'lpm']);
def('flow', 3.785412e-3 / 60, ['gpm', 'galus/min', 'gal/min']);
def('flow', 0.1589873 / 86400, ['bbl/d', 'bpd', 'stb/d', 'bbl/day']);
def('flow', 0.1589873 / 60, ['bbl/min', 'bpm']);
// volume (m3)
def('volume', 1, ['m3', 'sm3']);
def('volume', 0.001, ['l', 'litre', 'liter']);
def('volume', 0.1589873, ['bbl', 'stb']);
def('volume', 3.785412e-3, ['gal', 'galus']);
def('volume', 0.02831685, ['ft3', 'scf']);
// speed / rate of penetration (m/s)
def('speed', 1, ['m/s']);
def('speed', 1 / 3600, ['m/h', 'm/hr', 'mph.m']);
def('speed', 0.3048 / 3600, ['ft/h', 'ft/hr', 'fph']);
def('speed', 1 / 60, ['m/min']);
def('speed', 0.3048 / 60, ['ft/min']);
// force (N)
def('force', 1, ['n']);
def('force', 1e3, ['kn']);
def('force', 4.448222, ['lbf']);
def('force', 4448.222, ['klbf', 'kip', 'kips', '1000lbf']);
def('force', 9.80665, ['kgf']);
def('force', 9806.65, ['tf', 'tonf', 'mt', 'tonne', 'tonnes', 't']);
// torque (N·m)
def('torque', 1, ['n.m', 'nm']);
def('torque', 1e3, ['kn.m', 'knm']);
def('torque', 1.355818, ['ft.lbf', 'lbf.ft', 'ftlb', 'ft.lb']);
def('torque', 1355.818, ['kft.lbf', 'klbf.ft', 'kftlb', '1000ft.lbf']);
// rotation (rad/s)
def('rotation', (2 * Math.PI) / 60, ['rpm', 'rev/min', 'c/min']);
def('rotation', 1, ['rad/s']);
// angle (rad)
def('angle', Math.PI / 180, ['deg', 'dega', 'degree', 'degrees']);
def('angle', 1, ['rad']);
// time (s)
def('time', 1, ['s', 'sec']);
def('time', 1e-3, ['ms']);
def('time', 60, ['min']);
def('time', 3600, ['h', 'hr']);
def('time', 86400, ['d', 'day']);
// sonic slowness (s/m)
def('slowness', 1e-6, ['us/m']);
def('slowness', 1e-6 / 0.3048, ['us/ft', 'usec/ft']);
// resistivity (ohm·m), conductivity (S/m)
def('resistivity', 1, ['ohm.m', 'ohmm', 'ohm.m2/m', 'ohmm.', 'ωm', 'ω.m']);
def('conductivity', 1, ['s/m']);
def('conductivity', 1e-3, ['ms/m', 'mmho/m']);
// fractions
def('fraction', 1, ['v/v', 'frac', 'fraction', 'dec', 'm3/m3', 'ft3/ft3']);
def('fraction', 0.01, ['%', 'pu', 'percent', 'p.u.']);

export function dimension(u: string | undefined): string | undefined {
  return u ? T[norm(u)]?.dim : undefined;
}

export function canConvert(from: string | undefined, to: string | undefined): boolean {
  const a = from && T[norm(from)];
  const b = to && T[norm(to)];
  return !!a && !!b && a.dim === b.dim;
}

/** A function converting values from one unit to another; null when they are not the same kind of quantity. */
export function converter(from: string, to: string): ((v: number) => number) | null {
  const a = T[norm(from)];
  const b = T[norm(to)];
  if (!a || !b || a.dim !== b.dim) return null;
  if (a.k === b.k && (a.off ?? 0) === (b.off ?? 0)) return (v) => v;
  const ka = a.k;
  const oa = a.off ?? 0;
  const kb = b.k;
  const ob = b.off ?? 0;
  return (v) => (v * ka + oa - ob) / kb;
}

/** The unit a dimension is shown in inside BoreWalk (metric, as the Volve data). */
export const PREFERRED: Record<string, string> = {
  length: 'm',
  pressure: 'bar',
  temperature: 'degC',
  density: 'g/cm3',
  flow: 'L/min',
  volume: 'm3',
  speed: 'm/h',
  force: 'kN',
  torque: 'kN.m',
  rotation: 'rpm',
  angle: 'deg',
  slowness: 'us/ft',
};
