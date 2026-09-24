import * as THREE from 'three';

/**
 * Scene frame: 1 unit = 1 m, x = east, y = elevation relative to MSL
 * (datum elevation − TVD), z = −north (right-handed, y up).
 */
export class Coords {
  constructor(public datumElevation: number) {}

  toScene(ns: number, ew: number, tvd: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(ew, this.datumElevation - tvd, -ns);
  }

  fromScene(v: THREE.Vector3): { ns: number; ew: number; tvd: number; tvdss: number } {
    const tvd = this.datumElevation - v.y;
    return { ns: -v.z, ew: v.x, tvd, tvdss: -v.y };
  }
}
