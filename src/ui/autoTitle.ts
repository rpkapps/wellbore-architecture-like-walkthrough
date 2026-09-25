/**
 * Anything cut off with an ellipsis shows its full text on hover: when the
 * pointer enters an element (or one of its near ancestors) that truncates
 * and actually overflows, its text becomes the element's native tooltip.
 * Elements with their own title, or a tooltip of their own, keep it.
 */
export function installAutoTitle(root: Document = document) {
  const marked = new WeakSet<Element>();
  root.addEventListener(
    'pointerover',
    (e) => {
      let el = e.target as HTMLElement | null;
      for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
        if (el.hasAttribute('title')) return;
        const overflows = el.scrollWidth > el.clientWidth + 1;
        if (overflows && getComputedStyle(el).textOverflow === 'ellipsis') {
          const text = el.textContent?.replace(/\s+/g, ' ').trim();
          if (text) {
            el.setAttribute('title', text);
            marked.add(el);
          }
          return;
        }
      }
    },
    { passive: true },
  );
  // a title set here is dropped once the text fits again (the panel was widened)
  root.addEventListener(
    'pointerout',
    (e) => {
      const el = e.target as HTMLElement | null;
      if (el && marked.has(el) && el.scrollWidth <= el.clientWidth + 1) {
        el.removeAttribute('title');
        marked.delete(el);
      }
    },
    { passive: true },
  );
}
