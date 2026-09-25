import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { DEFAULT_ERROR_MODEL, ellipseAt, uncertaintyAlong, type Ellipse } from '../data/uncertainty';
import type { App } from '../ui/app';
import { Note, SelectField } from '../ui/controls';
import { fmt } from '../ui/dom';
import { Rev } from '../ui/signal';
import type { FeatureModule } from './registry';

/** Position-uncertainty ellipses swept along the active trajectory. */
export class UncertaintyFeature implements FeatureModule {
  readonly id = 'uncertainty' as const;
  readonly rev = new Rev();
  sigma = 2;
  ellipses: Ellipse[] = [];
  private group = new THREE.Group();

  constructor(private app: App) {
    this.group.name = 'uncertainty';
  }

  enable() {
    this.app.engine.scene.add(this.group);
    this.rebuild();
  }

  disable() {
    this.app.engine.scene.remove(this.group);
    this.clear();
  }

  onWell() {
    this.rebuild();
  }

  /** k·σ vertical (TVD) uncertainty at md, metres. */
  verticalAt(md: number): number | null {
    const e = ellipseAt(this.ellipses, md);
    return e ? e.vertical * this.sigma : null;
  }

  settings() {
    const w = this.app.engine.activeWell;
    const last = this.ellipses[this.ellipses.length - 1];
    const m = DEFAULT_ERROR_MODEL;
    return (
      <>
        <SelectField
          label="Ellipse size"
          value={String(this.sigma)}
          onChange={(v) => {
            this.sigma = +v;
            this.rebuild();
          }}
          options={[1, 2, 3].map((k) => ({ id: String(k), label: `${k}σ (${k === 1 ? '68' : k === 2 ? '95' : '99.7'}% for a 1-D error)` }))}
        />
        <Note>
          Simplified systematic MWD model: σinc {m.sigInc}°, σazi {m.sigAzi}°, depth {m.sigDepth * 1000} ‰ of MD
          {w?.trajectory.status === 'reconstructed' || w?.trajectory.status === 'user' ? ', plus a reconstruction allowance growing away from the picks' : ''}. Not a full ISCWSA tool-code model.
        </Note>
        {last && (
          <Note>
            At TD ({fmt.n(last.md, 0)} m): {fmt.n(last.major * this.sigma, 1)} × {fmt.n(last.minor * this.sigma, 1)} m across hole, ±{fmt.n(last.vertical * this.sigma, 1)} m vertical.
          </Note>
        )}
      </>
    );
  }

  private clear() {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
      if (c instanceof CSS2DObject) c.element.remove();
    }
  }

  rebuild() {
    this.clear();
    this.rev.bump();
    const e = this.app.engine;
    const w = e.activeWell;
    if (!w) return;
    const t = w.trajectory;
    const recon = t.status === 'reconstructed' || t.status === 'user';
    this.ellipses = uncertaintyAlong(t, 10, DEFAULT_ERROR_MODEL, recon ? { reconstructedFrom: w.kickoffMD ?? 0, picks: w.tops } : {});
    const E = this.ellipses;
    if (E.length < 2) return;
    const k = this.sigma;
    const SEG = 36;
    const pos: number[] = [];
    const aT: number[] = [];
    const idx: number[] = [];
    const ned2scene = (v: [number, number, number]) => new THREE.Vector3(v[1], -v[2], -v[0]);
    const dz = this.app.field.meta.datumElevation;
    const rings: THREE.Vector3[][] = [];
    for (const el of E) {
      const p = t.at(Math.min(el.md, t.mdEnd));
      const c = e.coords.toScene(p.ns, p.ew, p.tvd);
      const a = ned2scene(el.majorDir);
      const b = ned2scene(el.minorDir);
      const ring: THREE.Vector3[] = [];
      for (let j = 0; j <= SEG; j++) {
        const th = (j / SEG) * Math.PI * 2;
        const q = c.clone().addScaledVector(a, Math.cos(th) * el.major * k).addScaledVector(b, Math.sin(th) * el.minor * k);
        ring.push(q);
        pos.push(q.x, q.y, q.z);
        aT.push(el.md / Math.max(1, t.mdEnd));
      }
      rings.push(ring);
    }
    void dz;
    for (let i = 0; i < E.length - 1; i++)
      for (let j = 0; j < SEG; j++) {
        const a = i * (SEG + 1) + j;
        const b = a + SEG + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {},
      vertexShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aT; varying float vT; varying vec3 vN; varying vec3 vV;
void main(){
  vT = aT;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`,
      fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying float vT; varying vec3 vN; varying vec3 vV;
void main(){
  #include <logdepthbuf_fragment>
  float rim = pow(1.0 - abs(dot(normalize(vN), vV)), 2.0);
  vec3 c = mix(vec3(0.55, 0.75, 1.0), vec3(0.8, 0.6, 1.0), vT);
  gl_FragColor = vec4(c, 0.04 + 0.32 * rim);
}`,
    });
    const cone = new THREE.Mesh(g, mat);
    cone.renderOrder = 55;
    this.group.add(cone);
    // outline rings every 250 m
    let next = 0;
    for (let i = 0; i < E.length; i++) {
      if (E[i].md < next && i !== E.length - 1) continue;
      next = E[i].md + 250;
      const lg = new THREE.BufferGeometry().setFromPoints(rings[i]);
      const l = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xb8c8ff, transparent: true, opacity: 0.6 }));
      l.renderOrder = 56;
      this.group.add(l);
    }
    const last = E[E.length - 1];
    const el = document.createElement('div');
    el.className = 'label3d unc';
    el.innerHTML = `<b>${k}σ position uncertainty</b><span>${fmt.n(last.major * k, 1)} × ${fmt.n(last.minor * k, 1)} m at TD · calculated</span>`;
    const o = new CSS2DObject(el);
    o.position.copy(rings[rings.length - 1][0]);
    this.group.add(o);
  }
}
