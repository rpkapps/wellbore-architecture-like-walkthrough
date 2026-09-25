/**
 * A small non-validating XML reader for WITSML documents (and SOAP
 * envelopes around them). Workers have no DOMParser, so this builds a plain
 * tree: local names (namespace prefixes dropped), attributes, children and
 * text. Comments, processing instructions and DOCTYPE are skipped; CDATA and
 * the standard and numeric entities are read.
 */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENT[e] ?? m;
  });
}

const local = (n: string) => {
  const i = n.indexOf(':');
  return i >= 0 ? n.slice(i + 1) : n;
};

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += unescapeXml(src.slice(i));
      break;
    }
    if (lt > i) top.text += unescapeXml(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      top.text += src.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
    } else if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
    } else if (src.startsWith('<!', lt)) {
      // DOCTYPE, possibly with an internal subset
      let d = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        if (src[j] === '[') d++;
        else if (src[j] === ']') d--;
        else if (src[j] === '>' && d <= 0) break;
      }
      i = j + 1;
    } else if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      const name = local(src.slice(lt + 2, e).trim());
      // close up to the matching element (forgiving of stray tags)
      for (let k = stack.length - 1; k > 0; k--)
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      i = e < 0 ? n : e + 1;
    } else {
      // a start tag: find its end outside quoted attribute values
      let j = lt + 1;
      let q = '';
      for (; j < n; j++) {
        const c = src[j];
        if (q) {
          if (c === q) q = '';
        } else if (c === '"' || c === "'") q = c;
        else if (c === '>') break;
      }
      const selfClose = src[j - 1] === '/';
      const body = src.slice(lt + 1, selfClose ? j - 1 : j);
      const m = /^([^\s/>]+)/.exec(body);
      const node: XmlNode = { name: local(m ? m[1] : ''), attrs: {}, children: [], text: '' };
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = re.exec(body))) node.attrs[local(a[1])] = unescapeXml(a[3] ?? a[4] ?? '');
      top.children.push(node);
      if (!selfClose) stack.push(node);
      i = j + 1;
    }
  }
  return root;
}

// ------------------------------------------------------------------ small helpers

export const child = (n: XmlNode | undefined, name: string): XmlNode | undefined => n?.children.find((c) => c.name === name);
export const kids = (n: XmlNode | undefined, name: string): XmlNode[] => n?.children.filter((c) => c.name === name) ?? [];
export const textOf = (n: XmlNode | undefined, name?: string): string => ((name ? child(n, name) : n)?.text ?? '').trim();

/** Every descendant with this name (depth first). */
export function find(n: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    else find(c, name, out);
  }
  return out;
}
