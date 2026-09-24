import { h } from './dom';
import { I } from './icons';

export interface FloatingOptions {
  id: string;
  title: string;
  /** chip html next to the title */
  badge?: string;
  width: number;
  height: number;
  /** default placement when the user has not moved it */
  place: 'bottom-center' | 'top-center' | 'bottom-left' | 'top-left' | 'center' | 'dock-bottom';
  onClose?: () => void;
  headExtra?: HTMLElement[];
}

// v2: v1 saved positions from the first layout could land on the timeline
const KEY = 'vwt.panels.v2';

function loadPos(): Record<string, { x: number; y: number; w: number; h: number }> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

/**
 * Draggable, resizable glass window used by the optional feature panels
 * (geosteering strip, cross-section, simulation, saved views …). Its position
 * and size are remembered per browser.
 */
export class FloatingPanel {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  readonly head: HTMLElement;
  onResize?: () => void;
  private placed = false;

  constructor(private opts: FloatingOptions) {
    this.body = h('div', { class: 'fp-body' });
    const close = h('button', { class: 'btn icon ghost', title: 'Close', html: I.close });
    close.onclick = () => (opts.onClose ? opts.onClose() : this.hide());
    this.head = h(
      'div',
      { class: 'fp-head' },
      h('h4', {}, opts.title),
      opts.badge ? h('span', { html: opts.badge }) : null,
      h('div', { class: 'spacer' }),
      ...(opts.headExtra ?? []),
      close,
    );
    this.el = h('div', { class: 'floating glass hidden', id: `fp-${opts.id}` }, this.head, this.body);
    this.el.style.width = `${opts.width}px`;
    this.el.style.height = `${opts.height}px`;
    this.bindDrag();
    // remember a size only when the user resizes it (the CSS resize grip), never from layout
    this.el.addEventListener('pointerdown', (e) => {
      const r = this.el.getBoundingClientRect();
      if (e.clientX > r.right - 18 && e.clientY > r.bottom - 18) this.userResizing = true;
    });
    window.addEventListener('pointerup', () => {
      if (!this.userResizing) return;
      this.userResizing = false;
      this.clamp();
      this.save();
    });
    new ResizeObserver(() => this.onResize?.()).observe(this.el);
    window.addEventListener('resize', () => {
      if (this.visible) this.clamp();
    });
    document.body.appendChild(this.el);
  }

  private userResizing = false;

  /**
   * Keep the window inside the free area between the top bar and the timeline
   * (and on screen), so it can never cover the play button or the scrubber.
   */
  clamp() {
    const W = window.innerWidth;
    const top = (document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 64) + 8;
    const bottom = (document.querySelector('.timeline')?.getBoundingClientRect().top ?? window.innerHeight - 104) - 8;
    const r = this.el.getBoundingClientRect();
    const h = Math.max(120, Math.min(r.height, bottom - top));
    const w = Math.min(r.width, W - 16);
    const x = Math.max(8, Math.min(W - w - 8, r.left));
    const y = Math.max(top, Math.min(bottom - h, r.top));
    if (h !== r.height) this.el.style.height = `${h}px`;
    if (w !== r.width) this.el.style.width = `${w}px`;
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  show() {
    if (!this.placed) this.place();
    this.el.classList.remove('hidden');
    this.clamp();
    requestAnimationFrame(() => this.onResize?.());
  }

  hide() {
    this.el.classList.add('hidden');
  }

  destroy() {
    this.el.remove();
  }

  private place() {
    const saved = loadPos()[this.opts.id];
    const W = window.innerWidth;
    const H = window.innerHeight;
    let { width: w, height: hh } = this.opts;
    let x: number;
    let y: number;
    if (saved) {
      ({ x, y } = saved);
      w = saved.w;
      hh = saved.h;
    } else {
      const top = 52 + 24;
      const bottom = 92 + 24;
      switch (this.opts.place) {
        case 'dock-bottom': {
          // the free band above the timeline, between the side panels
          const left = document.querySelector('.panel.left:not(.collapsed)')?.getBoundingClientRect();
          const right = document.querySelector('.panel.right:not(.collapsed)')?.getBoundingClientRect();
          const l = left ? left.right + 12 : 12;
          const r = right ? right.left - 12 : W - 12;
          x = l;
          w = Math.max(360, r - l);
          y = H - bottom - hh - 4;
          break;
        }
        case 'bottom-center':
          x = (W - w) / 2;
          y = H - bottom - hh - 8;
          break;
        case 'top-center':
          x = (W - w) / 2;
          y = top + 60;
          break;
        case 'bottom-left':
          x = 320;
          y = H - bottom - hh - 8;
          break;
        case 'top-left':
          x = 320;
          y = top;
          break;
        default:
          x = (W - w) / 2;
          y = (H - hh) / 2;
      }
    }
    w = Math.min(w, W - 24);
    hh = Math.min(hh, H - 80);
    this.el.style.width = `${w}px`;
    this.el.style.height = `${hh}px`;
    this.el.style.left = `${Math.max(8, Math.min(W - 80, x))}px`;
    this.el.style.top = `${Math.max(56, Math.min(H - 60, y))}px`;
    this.placed = true;
  }

  private save() {
    try {
      const all = loadPos();
      const r = this.el.getBoundingClientRect();
      all[this.opts.id] = { x: r.left, y: r.top, w: r.width, h: r.height };
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }

  private bindDrag() {
    let start: { x: number; y: number; l: number; t: number } | null = null;
    this.head.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button, select, input')) return;
      const r = this.el.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, l: r.left, t: r.top };
      this.head.setPointerCapture(e.pointerId);
      this.el.classList.add('dragging');
    });
    this.head.addEventListener('pointermove', (e) => {
      if (!start) return;
      const l = start.l + e.clientX - start.x;
      const t = start.t + e.clientY - start.y;
      this.el.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, l))}px`;
      this.el.style.top = `${Math.max(48, Math.min(window.innerHeight - 40, t))}px`;
    });
    const end = () => {
      if (!start) return;
      start = null;
      this.el.classList.remove('dragging');
      this.clamp();
      this.save();
    };
    this.head.addEventListener('pointerup', end);
    this.head.addEventListener('pointercancel', end);
  }
}

/** Canvas helper: size the backing store to the element and return a DPR-scaled context. */
export function fitCanvas(cv: HTMLCanvasElement): { g: CanvasRenderingContext2D; W: number; H: number } | null {
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  if (!W || !H) return null;
  const dpr = Math.min(2, devicePixelRatio || 1);
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  return { g, W, H };
}
