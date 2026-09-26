/** A MessagePack decoder (the whole spec except extension types, which read as their raw bytes). */
export function decodeMsgpack(buf: Uint8Array): unknown[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const td = new TextDecoder();
  let p = 0;
  const need = (n: number) => {
    if (p + n > buf.length) throw new Error('MessagePack: data ends inside a value.');
  };
  const str = (n: number) => {
    need(n);
    const s = td.decode(buf.subarray(p, p + n));
    p += n;
    return s;
  };
  const bin = (n: number) => {
    need(n);
    const b = buf.slice(p, p + n);
    p += n;
    return b;
  };
  const arr = (n: number): unknown[] => {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = read();
    return a;
  };
  const map = (n: number): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) {
      const k = read();
      o[String(k)] = read();
    }
    return o;
  };
  const u8 = () => (need(1), buf[p++]);
  const u16 = () => (need(2), (p += 2), dv.getUint16(p - 2));
  const u32 = () => (need(4), (p += 4), dv.getUint32(p - 4));
  const ext = (n: number) => {
    const type = dv.getInt8((need(1), p++));
    const data = bin(n);
    // timestamp extension → epoch ms
    if (type === -1) {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (n === 4) return d.getUint32(0) * 1000;
      if (n === 8) {
        const hi = d.getUint32(0);
        const lo = d.getUint32(4);
        return ((hi & 0x3) * 2 ** 32 + lo) * 1000 + (hi >>> 2) / 1e6;
      }
      if (n === 12) return Number(d.getBigInt64(4)) * 1000 + d.getUint32(0) / 1e6;
    }
    return data;
  };
  function read(): unknown {
    const b = u8();
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if ((b & 0xf0) === 0x80) return map(b & 0x0f);
    if ((b & 0xf0) === 0x90) return arr(b & 0x0f);
    if ((b & 0xe0) === 0xa0) return str(b & 0x1f);
    switch (b) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return bin(u8());
      case 0xc5:
        return bin(u16());
      case 0xc6:
        return bin(u32());
      case 0xc7:
        return ext(u8());
      case 0xc8:
        return ext(u16());
      case 0xc9:
        return ext(u32());
      case 0xca:
        need(4);
        p += 4;
        return dv.getFloat32(p - 4);
      case 0xcb:
        need(8);
        p += 8;
        return dv.getFloat64(p - 8);
      case 0xcc:
        return u8();
      case 0xcd:
        return u16();
      case 0xce:
        return u32();
      case 0xcf:
        need(8);
        p += 8;
        return Number(dv.getBigUint64(p - 8));
      case 0xd0:
        need(1);
        return dv.getInt8(p++);
      case 0xd1:
        need(2);
        p += 2;
        return dv.getInt16(p - 2);
      case 0xd2:
        need(4);
        p += 4;
        return dv.getInt32(p - 4);
      case 0xd3:
        need(8);
        p += 8;
        return Number(dv.getBigInt64(p - 8));
      case 0xd4:
        return ext(1);
      case 0xd5:
        return ext(2);
      case 0xd6:
        return ext(4);
      case 0xd7:
        return ext(8);
      case 0xd8:
        return ext(16);
      case 0xd9:
        return str(u8());
      case 0xda:
        return str(u16());
      case 0xdb:
        return str(u32());
      case 0xdc:
        return arr(u16());
      case 0xdd:
        return arr(u32());
      case 0xde:
        return map(u16());
      case 0xdf:
        return map(u32());
    }
    throw new Error(`MessagePack: unknown type byte 0x${b.toString(16)}.`);
  }
  const out: unknown[] = [];
  while (p < buf.length) out.push(read());
  return out;
}
