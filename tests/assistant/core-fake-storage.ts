/*
 * Small in-memory stand-ins for the browser storages the assistant's
 * persistence uses (not a test file itself): a `Storage` and the part of
 * IndexedDB it needs (object stores with a key path, one index, readwrite
 * transactions that commit when idle and roll back on abort). Both can be
 * told to refuse writes with a QuotaExceededError.
 */

const quotaError = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });

/** A `Storage` in memory; `quota` caps the total characters of its values. */
export function fakeStorage(quota = Infinity): Storage & { data: Map<string, string>; quota: number } {
  const data = new Map<string, string>();
  const used = () => [...data.values()].reduce((n, v) => n + v.length, 0);
  return {
    data,
    quota,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem(k: string, v: string) {
      if (used() - (data.get(k)?.length ?? 0) + v.length > this.quota) throw quotaError();
      data.set(k, String(v));
    },
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

interface StoreData {
  keyPath: string;
  indexes: Map<string, string>;
  rows: Map<string, unknown>;
}
type DbData = Map<string, StoreData>;

const later = (fn: () => void) => setTimeout(fn, 0);
const matches = (v: unknown, keyPath: string, q?: unknown) => q === undefined || (v as Record<string, unknown>)[keyPath] === q;

/** The part of `IDBFactory` the persistence uses. `quota` caps the characters of all rows (checked at commit); `failPuts` makes every write transaction abort. */
export function fakeIndexedDB(opts: { quota?: number } = {}) {
  const dbs = new Map<string, DbData>();
  const control = { quota: opts.quota ?? Infinity, failPuts: false, dbs, commits: 0 };

  const size = (db: DbData) => {
    let n = 0;
    for (const s of db.values()) for (const v of s.rows.values()) n += JSON.stringify(v).length;
    return n;
  };

  function transaction(db: DbData, names: string | string[], mode: IDBTransactionMode = 'readonly') {
    const list = Array.isArray(names) ? names : [names];
    const backup = new Map(list.map((n) => [n, new Map(db.get(n)!.rows)]));
    let pending = 0;
    let finished = false;
    const tx = {
      error: null as unknown,
      oncomplete: null as null | (() => void),
      onerror: null as null | (() => void),
      onabort: null as null | (() => void),
      abort() {
        if (finished) throw Object.assign(new Error('finished'), { name: 'InvalidStateError' });
        fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      },
      objectStore: (name: string) => objectStore(name),
    };
    const fail = (error: unknown) => {
      finished = true;
      for (const [n, rows] of backup) db.get(n)!.rows = rows;
      tx.error = error;
      later(() => tx.onabort?.());
    };
    const maybeCommit = () =>
      later(() => {
        if (finished || pending) return;
        finished = true;
        if (mode === 'readwrite') {
          if (control.failPuts || size(db) > control.quota) {
            finished = false;
            return fail(quotaError());
          }
          control.commits++;
        }
        tx.oncomplete?.();
      });
    const request = <T>(run: () => T) => {
      if (finished) throw Object.assign(new Error('The transaction has finished.'), { name: 'TransactionInactiveError' });
      pending++;
      const r = { result: undefined as T | undefined, error: null as unknown, onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
      later(() => {
        pending--;
        if (finished) {
          r.error = tx.error;
          r.onerror?.();
          return;
        }
        r.result = run();
        r.onsuccess?.();
        maybeCommit();
      });
      return r;
    };
    const objectStore = (name: string) => {
      const s = db.get(name)!;
      const write = () => {
        if (mode !== 'readwrite') throw Object.assign(new Error('read only'), { name: 'ReadOnlyError' });
      };
      return {
        put(v: unknown) {
          write();
          const copy = structuredClone(v); // throws DataCloneError like the real one
          const key = String((copy as Record<string, unknown>)[s.keyPath]);
          s.rows.set(key, copy);
          return request(() => key);
        },
        get: (key: string) => request(() => structuredClone(s.rows.get(String(key)))),
        getAll: () => request(() => [...s.rows.values()].map((v) => structuredClone(v))),
        delete(key: string) {
          write();
          s.rows.delete(String(key));
          return request(() => undefined);
        },
        index(indexName: string) {
          const path = s.indexes.get(indexName)!;
          return {
            getAll: (q?: unknown) => request(() => [...s.rows.values()].filter((v) => matches(v, path, q)).map((v) => structuredClone(v))),
            getAllKeys: (q?: unknown) => request(() => [...s.rows.entries()].filter(([, v]) => matches(v, path, q)).map(([k]) => k)),
          };
        },
      };
    };
    if (!list.length) maybeCommit();
    return tx;
  }

  const factory = {
    open(name: string) {
      const r = {
        result: undefined as unknown,
        error: null as unknown,
        onupgradeneeded: null as null | (() => void),
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
        onblocked: null as null | (() => void),
      };
      later(() => {
        const fresh = !dbs.has(name);
        const data: DbData = dbs.get(name) ?? new Map();
        dbs.set(name, data);
        const db = {
          objectStoreNames: { contains: (n: string) => data.has(n) },
          createObjectStore(n: string, o: { keyPath: string }) {
            const s: StoreData = { keyPath: o.keyPath, indexes: new Map(), rows: new Map() };
            data.set(n, s);
            return { createIndex: (i: string, path: string) => void s.indexes.set(i, path) };
          },
          transaction: (names: string | string[], mode?: IDBTransactionMode) => transaction(data, names, mode),
          onversionchange: null as unknown,
          close() {},
        };
        r.result = db;
        if (fresh) r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
  return { indexedDB: factory as unknown as IDBFactory, control };
}
