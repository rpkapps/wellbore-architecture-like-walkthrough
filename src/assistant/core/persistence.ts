import type { AssistantSettings, Dataset, ProviderConfig, Thread } from './types';

/*
 * Where threads and settings live. Threads go to IndexedDB (database
 * `<storageKey>-assistant`: thread list, messages and datasets in separate
 * stores, so the list loads without the transcripts); a save IndexedDB
 * refuses goes to localStorage (without IndexedDB: localStorage, then
 * memory), and reads look in both. Saves are debounced and happen at turn
 * ends and thread changes, never per streamed token. Settings live in
 * localStorage; API keys only when the person asked to remember them,
 * otherwise in sessionStorage (gone when the browser session ends).
 */

export type ThreadMeta = Pick<Thread, 'id' | 'title' | 'createdAt' | 'updatedAt'>;

export interface Persistence {
  readonly kind: 'indexeddb' | 'localstorage' | 'memory';
  loadSettings: () => Partial<AssistantSettings> | null;
  saveSettings: (settings: AssistantSettings) => void;
  loadCurrentThreadId: () => string | null;
  saveCurrentThreadId: (id: string | null) => void;
  listThreads: () => Promise<ThreadMeta[]>;
  loadThread: (id: string) => Promise<Thread | null>;
  /** debounced: the latest version of each thread is written shortly after */
  saveThread: (thread: Thread) => void;
  deleteThread: (id: string) => Promise<void>;
  /** writes pending saves now */
  flush: () => Promise<void>;
  dispose: () => void;
}

/** The browser storages to use instead of the global ones (tests). `null`: none. */
export interface PersistenceStorages {
  indexedDB?: IDBFactory | null;
  localStorage?: Storage | null;
  sessionStorage?: Storage | null;
}

interface Backend {
  kind: Persistence['kind'];
  list: () => Promise<ThreadMeta[]>;
  get: (id: string) => Promise<Thread | null>;
  put: (thread: Thread) => Promise<void>;
  delete: (id: string) => Promise<void>;
}

const meta = (t: ThreadMeta): ThreadMeta => ({ id: t.id, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt });

/** A dataset with more rows than this is saved without them when the storage is full. */
export const TRIM_ROWS = 2_000;

const isQuotaError = (e: unknown) => {
  const x = e as { name?: string; code?: number } | null;
  return !!x && (x.name === 'QuotaExceededError' || x.name === 'NS_ERROR_DOM_QUOTA_REACHED' || x.code === 22 || x.code === 1014);
};

/** The thread with the rows of its large datasets left out (marked `trimmed`); the same object when none is large. */
function trimDatasets(t: Thread): Thread {
  let changed = false;
  const datasets: Record<string, Dataset> = {};
  for (const [id, d] of Object.entries(t.datasets)) {
    if (d.rows.length <= TRIM_ROWS) datasets[id] = d;
    else {
      changed = true;
      datasets[id] = { ...d, rows: [], trimmed: { rowCount: d.rows.length } };
    }
  }
  return changed ? { ...t, datasets } : t;
}

function storage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    const s = (globalThis as Record<string, unknown>)[kind] as Storage | undefined;
    if (!s) return null;
    const probe = '__assistant_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

const readJson = <T>(s: Storage | null, key: string): T | null => {
  try {
    const v = s?.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
};
const writeJson = (s: Storage | null, key: string, value: unknown) => {
  try {
    if (value === null || value === undefined) s?.removeItem(key);
    else s?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

// ------------------------------------------------------------------ backends

function memoryBackend(): Backend {
  const threads = new Map<string, Thread>();
  return {
    kind: 'memory',
    list: async () => [...threads.values()].map(meta),
    get: async (id) => threads.get(id) ?? null,
    put: async (t) => void threads.set(t.id, t),
    delete: async (id) => void threads.delete(id),
  };
}

function localStorageBackend(ls: Storage, prefix: string): Backend {
  const listKey = `${prefix}.assistant.threads`;
  const threadKey = (id: string) => `${prefix}.assistant.thread.${id}`;
  const list = () => readJson<ThreadMeta[]>(ls, listKey) ?? [];
  return {
    kind: 'localstorage',
    list: async () => list(),
    get: async (id) => readJson<Thread>(ls, threadKey(id)),
    async put(t) {
      // datasets can be large: if the quota refuses them, keep the small ones, then the transcript at least
      let error: unknown;
      for (const version of [t, trimDatasets(t), { ...t, datasets: {} }]) {
        try {
          ls.setItem(threadKey(t.id), JSON.stringify(version));
          ls.setItem(listKey, JSON.stringify([meta(t), ...list().filter((m) => m.id !== t.id)]));
          return;
        } catch (e) {
          error = e;
        }
      }
      throw error;
    },
    async delete(id) {
      writeJson(ls, threadKey(id), null);
      writeJson(ls, listKey, list().filter((m) => m.id !== id));
    },
  };
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });

function idbBackend(idb: IDBFactory, name: string): Backend {
  let dbp: Promise<IDBDatabase> | null = null;
  const savedDatasets = new Set<string>();
  const open = () =>
    (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = idb.open(name, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('threads')) db.createObjectStore('threads', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('datasets')) db.createObjectStore('datasets', { keyPath: 'key' }).createIndex('threadId', 'threadId');
      };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
    }));
  const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  return {
    kind: 'indexeddb',
    async list() {
      const db = await open();
      return (await req(db.transaction('threads').objectStore('threads').getAll() as IDBRequest<ThreadMeta[]>)).map(meta);
    },
    async get(id) {
      const db = await open();
      const tx = db.transaction(['threads', 'messages', 'datasets']);
      const [m, msgs, ds] = await Promise.all([
        req(tx.objectStore('threads').get(id) as IDBRequest<(ThreadMeta & { nextDatasetSeq?: number }) | undefined>),
        req(tx.objectStore('messages').get(id) as IDBRequest<{ id: string; messages: Thread['messages'] } | undefined>),
        req(tx.objectStore('datasets').index('threadId').getAll(id) as IDBRequest<{ key: string; dataset: Dataset }[]>),
      ]);
      if (!m) return null;
      const datasets: Record<string, Dataset> = {};
      for (const d of ds) {
        datasets[d.dataset.id] = d.dataset;
        savedDatasets.add(d.key);
      }
      const thread: Thread = { ...meta(m), messages: msgs?.messages ?? [], datasets };
      if (m.nextDatasetSeq) thread.nextDatasetSeq = m.nextDatasetSeq;
      return thread;
    },
    async put(t) {
      const db = await open();
      const tx = db.transaction(['threads', 'messages', 'datasets'], 'readwrite');
      const finished = done(tx);
      const written: string[] = [];
      const dropped: string[] = [];
      try {
        tx.objectStore('threads').put(t.nextDatasetSeq ? { ...meta(t), nextDatasetSeq: t.nextDatasetSeq } : meta(t));
        // structured clone refuses functions and the like a tool may have returned: store the JSON form then
        try {
          tx.objectStore('messages').put({ id: t.id, messages: t.messages });
        } catch {
          tx.objectStore('messages').put({ id: t.id, messages: plain(t.messages) });
        }
        const keep = new Set<string>();
        for (const d of Object.values(t.datasets)) {
          const key = `${t.id}/${d.id}`;
          keep.add(key);
          if (savedDatasets.has(key)) continue; // ids are never reused, so a saved dataset never changes
          tx.objectStore('datasets').put({ key, threadId: t.id, dataset: d });
          written.push(key);
        }
        // the datasets of answers that were regenerated or edited away go too
        const stored = tx.objectStore('datasets').index('threadId').getAllKeys(t.id);
        stored.onsuccess = () => {
          for (const k of stored.result) {
            if (keep.has(String(k))) continue;
            tx.objectStore('datasets').delete(k);
            dropped.push(String(k));
          }
        };
      } catch (e) {
        try {
          tx.abort();
        } catch {
          /* already finished */
        }
        await finished.catch(() => {});
        throw e;
      }
      await finished;
      written.forEach((k) => savedDatasets.add(k));
      dropped.forEach((k) => savedDatasets.delete(k));
    },
    async delete(id) {
      const db = await open();
      const tx = db.transaction(['threads', 'messages', 'datasets'], 'readwrite');
      const finished = done(tx);
      tx.objectStore('threads').delete(id);
      tx.objectStore('messages').delete(id);
      const keys = await req(tx.objectStore('datasets').index('threadId').getAllKeys(id));
      for (const k of keys) {
        tx.objectStore('datasets').delete(k);
        savedDatasets.delete(String(k));
      }
      await finished;
    },
  };
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = async <T>(fn: () => Promise<T>): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
};

/**
 * The primary store, and a fallback for what it refuses, one save at a time:
 * a save that fails (after one more try without the rows of large datasets
 * when the quota is full) goes to the fallback, every other thread stays
 * where it is. Reads merge both (the newer copy of a thread wins), deletes
 * clear both, and a fallback copy is dropped once the primary saves the thread.
 */
function layered(primary: Backend, fallback: Backend): Backend {
  let primaryFailing = false;
  const inFallback = new Set<string>();
  const onPrimary = async <T>(fn: () => Promise<T>): Promise<Settled<T>> => {
    const r = await settle(fn);
    primaryFailing = !r.ok;
    return r;
  };
  return {
    get kind() {
      return primaryFailing ? fallback.kind : primary.kind;
    },
    async list() {
      const [a, b] = await Promise.all([onPrimary(() => primary.list()), settle(() => fallback.list())]);
      if (!a.ok && !b.ok) throw a.error;
      const byId = new Map<string, ThreadMeta>();
      if (a.ok) for (const m of a.value) byId.set(m.id, m);
      if (b.ok)
        for (const m of b.value) {
          inFallback.add(m.id);
          const x = byId.get(m.id);
          if (!x || m.updatedAt > x.updatedAt) byId.set(m.id, m);
        }
      return [...byId.values()];
    },
    async get(id) {
      const [a, b] = await Promise.all([onPrimary(() => primary.get(id)), settle(() => fallback.get(id))]);
      if (!a.ok && !b.ok) throw a.error;
      const x = a.ok ? a.value : null;
      const y = b.ok ? b.value : null;
      if (y) inFallback.add(id);
      return x && y ? (y.updatedAt > x.updatedAt ? y : x) : (x ?? y);
    },
    async put(t) {
      let r = await onPrimary(() => primary.put(t));
      if (!r.ok && isQuotaError(r.error)) {
        const trimmed = trimDatasets(t);
        if (trimmed !== t) r = await onPrimary(() => primary.put(trimmed));
      }
      if (!r.ok) {
        await fallback.put(t);
        inFallback.add(t.id);
        return;
      }
      // the copy an earlier failed save left in the fallback is stale now
      if (inFallback.delete(t.id)) await settle(() => fallback.delete(t.id));
    },
    async delete(id) {
      inFallback.delete(id);
      const [a, b] = await Promise.all([onPrimary(() => primary.delete(id)), settle(() => fallback.delete(id))]);
      if (!a.ok && !b.ok) throw a.error;
    },
  };
}

// ------------------------------------------------------------------ settings

type StoredKeys = Record<string, string>;

/**
 * Creates the persistence for a storage namespace. `memory` keeps nothing
 * across reloads (tests, demos); `storages` replaces the browser's (tests).
 */
export function createPersistence(storageKey: string, mode: 'auto' | 'memory' = 'auto', storages: PersistenceStorages = {}): Persistence {
  const pick = <T>(given: T | null | undefined, global: () => T | null | undefined): T | null => (mode === 'memory' ? null : given !== undefined ? given : (global() ?? null));
  const ls = pick(storages.localStorage, () => storage('localStorage'));
  const ss = pick(storages.sessionStorage, () => storage('sessionStorage'));
  const memSettings: { settings: Partial<AssistantSettings> | null; keys: StoredKeys; current: string | null } = { settings: null, keys: {}, current: null };
  const settingsKey = `${storageKey}.assistant.settings`;
  const keysKey = `${storageKey}.assistant.keys`;
  const currentKey = `${storageKey}.assistant.current`;

  const idb = pick(storages.indexedDB, () => (globalThis as { indexedDB?: IDBFactory }).indexedDB);
  const secondary = ls ? localStorageBackend(ls, storageKey) : memoryBackend();
  const backend: Backend = idb ? layered(idbBackend(idb, `${storageKey}-assistant`), secondary) : ls ? layered(secondary, memoryBackend()) : secondary;

  const pending = new Map<string, Thread>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending.size) return writing;
    const batch = [...pending.values()];
    pending.clear();
    writing = writing.then(async () => {
      for (const t of batch) {
        try {
          await backend.put(t);
        } catch {
          /* storage refused: the thread stays in memory for this session */
        }
      }
    });
    return writing;
  };
  const onHide = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'hidden') void flush();
  };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', onHide);
    document.addEventListener?.('visibilitychange', onHide);
  }

  return {
    get kind() {
      return backend.kind;
    },
    loadSettings() {
      const s = ls ? readJson<Partial<AssistantSettings>>(ls, settingsKey) : memSettings.settings;
      if (!s) return null;
      const keys: StoredKeys = ss ? (readJson<StoredKeys>(ss, keysKey) ?? {}) : memSettings.keys;
      if (Array.isArray(s.providers)) s.providers = s.providers.map((p) => (p.apiKey || !keys[p.id] ? p : { ...p, apiKey: keys[p.id] }));
      return s;
    },
    saveSettings(settings) {
      const keys: StoredKeys = {};
      const providers: ProviderConfig[] = settings.providers.map((p) => {
        if (!p.apiKey || settings.rememberKeys) return p;
        keys[p.id] = p.apiKey;
        const copy = { ...p };
        delete copy.apiKey;
        return copy;
      });
      const stored = { ...settings, providers };
      if (ls) writeJson(ls, settingsKey, stored);
      else memSettings.settings = JSON.parse(JSON.stringify(settings)) as AssistantSettings;
      if (ss) writeJson(ss, keysKey, Object.keys(keys).length ? keys : null);
      else memSettings.keys = keys;
    },
    loadCurrentThreadId: () => (ls ? readJson<string>(ls, currentKey) : memSettings.current),
    saveCurrentThreadId(id) {
      if (ls) writeJson(ls, currentKey, id);
      else memSettings.current = id;
    },
    listThreads: async () => {
      try {
        return await backend.list();
      } catch {
        return [];
      }
    },
    loadThread: async (id) => {
      const p = pending.get(id);
      if (p) return p;
      await writing.catch(() => {});
      try {
        return await backend.get(id);
      } catch {
        return null;
      }
    },
    saveThread(thread) {
      pending.set(thread.id, thread);
      if (!timer) timer = setTimeout(() => void flush(), 400);
    },
    async deleteThread(id) {
      pending.delete(id);
      await writing.catch(() => {});
      try {
        await backend.delete(id);
      } catch {
        /* nothing stored */
      }
    },
    flush,
    dispose() {
      void flush();
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('pagehide', onHide);
        document.removeEventListener?.('visibilitychange', onHide);
      }
    },
  };
}
