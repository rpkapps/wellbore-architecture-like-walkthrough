import * as THREE from 'three';
import type { App } from '../ui/app';

/** The depth along the active well nearest a point of the scene (a click on an overlay drawn along it), m MD. */
export function mdNear(app: App, point: { x: number; y: number; z: number }): number | null {
  const w = app.engine.activeWell;
  if (!w) return null;
  const c = app.engine.coords.fromScene(new THREE.Vector3(point.x, point.y, point.z));
  return w.trajectory.closestMD(c.ns, c.ew, c.tvd).md;
}
