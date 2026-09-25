import { Button } from '@tecton/react/components/button';
import { CameraIcon } from 'lucide-react';
import * as THREE from 'three';
import { colormap, RES_RANGE, toCss } from '../data/colormap';
import type { App } from '../ui/app';
import { Note } from '../ui/controls';
import { Rev } from '../ui/signal';
import { font, ink } from '../ui/tokens';
import { ropRgb } from './curves';
import type { FeatureModule } from './registry';

/** High-resolution PNG export with labels, legend, north arrow and provenance composited in. */
export class SnapshotFeature implements FeatureModule {
  readonly id = 'snapshot' as const;
  labels = true;
  /** bump when `labels` changes, so the open menu shows it */
  readonly menuRev = new Rev();
  busy = false;

  constructor(private app: App) {}

  enable() {
    this.app.addTool({
      id: 'snapshot',
      label: 'Snapshot',
      icon: <CameraIcon />,
      watch: this.menuRev,
      menu: [
        { id: '2x', label: 'PNG · 2× screen', onAction: () => void this.capture('2x') },
        { id: '4k', label: 'PNG · 4K (3840 px)', onAction: () => void this.capture('4k') },
        {
          id: 'labels',
          label: 'Labels, legend & provenance',
          isSelected: () => this.labels,
          onAction: () => {
            this.labels = !this.labels;
            this.menuRev.bump();
          },
        },
      ],
    });
  }

  disable() {
    this.app.removeTool('snapshot');
  }

  settings() {
    return (
      <>
        <Note>Camera button in the view toolbar (bottom of the 3D view). Renders the current view off-screen at 2× or 4K with MSAA and post-processing, then draws the 3D labels, a legend, north arrow and data credits on top.</Note>
        <div className="flex gap-1.5">
          <Button variant="ghost" size="sm" onPress={() => void this.capture('2x')}>
            Snapshot 2×
          </Button>
          <Button variant="ghost" size="sm" onPress={() => void this.capture('4k')}>
            Snapshot 4K
          </Button>
        </div>
      </>
    );
  }

  async capture(kind: '2x' | '4k') {
    if (this.busy) return;
    this.busy = true;
    const app = this.app;
    const e = app.engine;
    const r = e.renderer;
    const host = r.domElement.parentElement!;
    const W = host.clientWidth;
    const H = host.clientHeight;
    const gl = r.getContext();
    const maxRb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
    let scale = kind === '4k' ? 3840 / W : 2;
    scale = Math.min(scale, maxRb / W, maxRb / H, Math.sqrt(40e6 / (W * H)));
    const oldPR = r.getPixelRatio();
    app.toast('Rendering snapshot …');
    await new Promise((res) => setTimeout(res, 30));
    try {
      r.setPixelRatio(scale);
      e.composer.setPixelRatio(scale);
      e.resize();
      e.renderFrame();
      const cw = r.domElement.width;
      const ch = r.domElement.height;
      const out = document.createElement('canvas');
      out.width = cw;
      out.height = ch;
      const g = out.getContext('2d')!;
      g.drawImage(r.domElement, 0, 0);
      if (this.labels) this.overlay(g, cw, ch, cw / W);
      const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'));
      if (!blob) throw new Error('Canvas export failed');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `borewalk_${e.activeWell.id}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
      document.body.append(a);
      a.click();
      setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
      app.toast(`Snapshot saved — ${cw} × ${ch} px`);
    } catch (err) {
      app.toast(`Snapshot failed: ${(err as Error).message}`);
    } finally {
      r.setPixelRatio(oldPR);
      e.composer.setPixelRatio(oldPR);
      e.resize();
      this.busy = false;
    }
  }

  private overlay(g: CanvasRenderingContext2D, W: number, H: number, k: number) {
    const app = this.app;
    const e = app.engine;
    const host = e.renderer.domElement.getBoundingClientRect();
    // 3D labels (CSS2D) at their current screen positions
    e.labelRenderer.render(e.scene, e.camera);
    const labels = e.labelRenderer.domElement.querySelectorAll<HTMLElement>('.label3d');
    g.textBaseline = 'top';
    for (const el of labels) {
      if (el.style.display === 'none' || el.offsetParent === null) continue;
      const op = parseFloat(el.style.opacity || '1');
      if (op < 0.2) continue;
      const rc = el.getBoundingClientRect();
      if (rc.width < 2 || rc.right < host.left || rc.left > host.right || rc.bottom < host.top || rc.top > host.bottom) continue;
      const parts = [...el.children].map((c) => (c.textContent ?? '').trim()).filter(Boolean);
      const lines = parts.length ? parts : el.innerText.split('\n').filter(Boolean);
      const x = (rc.left - host.left) * k;
      const y = (rc.top - host.top) * k;
      const fs = 11 * k;
      g.font = font.sans(fs, 600);
      const w = Math.max(...lines.map((l) => g.measureText(l).width)) + 12 * k;
      const hh = lines.length * fs * 1.3 + 8 * k;
      g.globalAlpha = op * 0.72;
      g.fillStyle = ink.card;
      roundRect(g, x, y, w, hh, 5 * k);
      g.fill();
      g.globalAlpha = op;
      lines.forEach((l, i) => {
        g.font = font.sans(fs * (i === 0 ? 1 : 0.9), i === 0 ? 600 : 400);
        g.fillStyle = i === 0 ? ink.text : ink.muted;
        g.fillText(l, x + 6 * k, y + 4 * k + i * fs * 1.3);
      });
      g.globalAlpha = 1;
    }
    // title block
    const f = app.field;
    const w = e.activeWell;
    const pad = 24 * k;
    const modeName = { resistivity: 'Measured resistivity', hydrocarbon: 'Interpreted hydrocarbons (calculated)', lithology: 'Lithology (operator picks)', rop: 'Rate of penetration (measured)' }[e.mode];
    card(g, pad, pad, 430 * k, 76 * k, 10 * k, 0.78);
    g.fillStyle = ink.primary;
    g.font = font.sans(18 * k, 700);
    g.fillText('BoreWalk', pad + 14 * k, pad + 12 * k);
    g.fillStyle = ink.text;
    g.font = font.sans(13 * k, 600);
    g.fillText(`${w.name} · ${f.meta.name} field, ${f.meta.block}`, pad + 14 * k, pad + 36 * k);
    g.fillStyle = ink.muted;
    g.font = font.sans(11.5 * k, 400);
    g.fillText(`${modeName} · MD ${e.rig.md.toFixed(0)} m · ${new Date().toISOString().slice(0, 10)}`, pad + 14 * k, pad + 55 * k);
    // colour bar
    const bw = 300 * k;
    const bx = W - bw - pad;
    const by = H - pad - 64 * k;
    card(g, bx - 12 * k, by - 26 * k, bw + 24 * k, 78 * k, 10 * k, 0.78);
    g.fillStyle = ink.text;
    g.font = font.sans(11.5 * k, 600);
    const grad = g.createLinearGradient(bx, 0, bx + bw, 0);
    let ticks: [number, string][] = [];
    if (e.mode === 'resistivity') {
      g.fillText('Formation resistivity · Ω·m (log) · measured', bx, by - 18 * k);
      for (let i = 0; i <= 20; i++) grad.addColorStop(i / 20, toCss(colormap(app.colormapName, i / 20)));
      const l0 = Math.log10(RES_RANGE.min);
      const l1 = Math.log10(RES_RANGE.max);
      ticks = [0.2, 1, 10, 100, 1000].map((v) => [(Math.log10(v) - l0) / (l1 - l0), String(v)]);
    } else if (e.mode === 'rop') {
      g.fillText('Rate of penetration · m/h (log) · measured', bx, by - 18 * k);
      for (let i = 0; i <= 20; i++) grad.addColorStop(i / 20, toCss(ropRgb(Math.pow(100, i / 20))));
      ticks = [1, 3, 10, 30, 100].map((v) => [Math.log10(v) / 2, String(v)]);
    } else if (e.mode === 'hydrocarbon') {
      g.fillText('Pore fluid · oil ← → water (Sw, calculated)', bx, by - 18 * k);
      grad.addColorStop(0, '#d98a1f');
      grad.addColorStop(1, '#2f7fc4');
      ticks = [
        [0, 'So 1'],
        [1, 'Sw 1'],
      ];
    } else {
      g.fillText('Formations — operator picks', bx, by - 18 * k);
      grad.addColorStop(0, '#6b5a4a');
      grad.addColorStop(1, '#c9a45c');
    }
    g.fillStyle = grad;
    g.fillRect(bx, by, bw, 12 * k);
    g.fillStyle = ink.muted;
    g.font = font.mono(10 * k);
    g.textAlign = 'center';
    for (const [t, s] of ticks) g.fillText(s, bx + t * bw, by + 17 * k);
    g.textAlign = 'left';
    // north arrow
    const dir = new THREE.Vector3();
    e.camera.getWorldDirection(dir);
    const heading = Math.atan2(dir.x, -dir.z);
    const cx = W - pad - 26 * k;
    const cy = pad + 30 * k;
    g.fillStyle = ink.card;
    g.globalAlpha = 0.72;
    g.beginPath();
    g.arc(cx, cy, 24 * k, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.save();
    g.translate(cx, cy);
    g.rotate(-heading);
    g.fillStyle = '#ff8a65';
    g.beginPath();
    g.moveTo(0, -17 * k);
    g.lineTo(6 * k, 4 * k);
    g.lineTo(-6 * k, 4 * k);
    g.closePath();
    g.fill();
    g.fillStyle = ink.text;
    g.font = font.sans(10 * k, 700);
    g.textAlign = 'center';
    g.fillText('N', 0, 6 * k);
    g.restore();
    g.textAlign = 'left';
    // credits
    g.fillStyle = ink.text;
    g.globalAlpha = 0.7;
    g.font = font.sans(10 * k, 400);
    g.fillText(`Data: Equinor and the ${f.meta.name} licence partners, Equinor Open Data Licence. ${f.meta.crs}. Near-well geometry radially exaggerated ×${e.radialScale}. Measured / calculated / reconstructed values labelled in the app.`, pad, H - pad);
    g.globalAlpha = 1;
  }
}

/** Backing box for the composited text: the Tecton card colour at `alpha`. */
function card(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, alpha: number) {
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = ink.card;
  roundRect(g, x, y, w, h, r);
  g.fill();
  g.restore();
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
