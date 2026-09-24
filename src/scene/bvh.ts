import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

// Raycasts use the BVH when a geometry has one and fall back to three's brute-force test otherwise.
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** Below this a brute-force raycast is already cheap. */
const MIN_TRIANGLES = 512;

function triangleCount(g: THREE.BufferGeometry): number {
  const n = g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0);
  return n / 3;
}

/**
 * Make sure a mesh geometry has an up-to-date BVH. Geometries whose vertices are
 * rewritten in place (radial-scale changes, the overview ribbon) are refitted
 * when their position buffer version moves on; new geometries get a fresh tree.
 */
export function ensureBVH(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || triangleCount(g) < MIN_TRIANGLES) return;
  const tree = g.boundsTree as MeshBVH | undefined;
  if (tree && g.userData.bvhVersion === pos.version) return;
  if (tree) tree.refit();
  // indirect: leave the render geometry's index untouched; range: the whole geometry, not the
  // draw range, which view culling narrows every frame
  else g.boundsTree = new MeshBVH(g, { indirect: true, range: { start: 0, count: g.index ? g.index.count : pos.count } });
  g.userData.bvhVersion = pos.version;
}

/** ensureBVH for every mesh under the given objects. */
export function ensureBVHFor(objects: THREE.Object3D[]) {
  for (const o of objects)
    o.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) ensureBVH((c as THREE.Mesh).geometry);
    });
}
