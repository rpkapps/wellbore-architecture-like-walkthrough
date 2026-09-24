/**
 * Core data model. Every numeric series carries a provenance tag so the UI can
 * always say whether a value was measured, calculated by this app, interpreted
 * by the operator, reconstructed, schematic or uploaded by the user.
 */
export type Provenance =
  | 'measured' // acquired by a logging / survey tool, as delivered by the operator
  | 'interpreted' // operator's published interpretation (e.g. Equinor CPI)
  | 'calculated' // computed live in this app from measured inputs + user parameters
  | 'reconstructed' // derived geometry (e.g. trajectory through pick coordinates)
  | 'schematic' // illustrative only, not backed by data in this package
  | 'user'; // uploaded by the user

export interface Curve {
  mnemonic: string;
  unit: string;
  description: string;
  values: Float32Array; // NaN = null
  provenance: Provenance;
  source: string;
}

export interface LogSet {
  wellName: string;
  depth: Float64Array; // measured depth, metres
  curves: Map<string, Curve>;
  header: Record<string, string>;
  source: string;
  provenance: Provenance;
}

export interface SurveyStation {
  md: number;
  inc: number;
  azi: number;
  tvd: number;
  ns: number;
  ew: number;
}

export type TrajectoryStatus = 'definitive' | 'measured' | 'reconstructed' | 'user';

export interface Top {
  name: string; // name as given by the source
  formationId: string;
  md: number;
  tvd?: number;
  obs?: number;
  source: string;
  provenance: Provenance;
}

export interface Zone {
  formationId: string;
  name: string;
  topMD: number;
  baseMD: number;
}

export interface ProductionRecord {
  t: number; // epoch ms (first day of period)
  hours: number;
  oil: number; // Sm3
  gas: number; // Sm3
  water: number; // Sm3
  waterInj: number; // Sm3
  bhp?: number; // bar
  bht?: number; // degC
  whp?: number; // bar
  choke?: number; // %
}

export interface ProductionSeries {
  wellName: string;
  period: 'daily' | 'monthly';
  records: ProductionRecord[];
  source: string;
  provenance: Provenance;
}

export interface PickRow {
  well: string;
  pick: string;
  obs: number;
  md: number;
  tvd: number;
  tvdss: number;
  e: number;
  n: number;
}

export interface ContextWell {
  name: string;
  md: Float64Array;
  tvd: Float64Array;
  ns: Float64Array;
  ew: Float64Array;
}

export interface HorizonGrid {
  id: string; // formation id whose top this horizon is
  name: string;
  nx: number;
  nz: number;
  x0: number; // east of origin (m)
  z0: number; // north of origin (m)
  dx: number;
  dz: number;
  depth: Float32Array; // TVDSS (m, positive down) row-major [iz*nx+ix]
  controlPoints: { x: number; n: number; tvdss: number; well: string }[];
}
