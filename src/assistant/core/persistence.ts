import type { AssistantSettings, Dataset, ProviderConfig, Thread } from './types';

/*
 * Where threads and settings live. Threads go to IndexedDB (database
 * `<storageKey>-assistant`: thread list, messages and datasets in separate
 * stores, so the list loads without the transcripts), falling back to
 * localStorage and then to memory. Saves are debounced and happen at turn
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

interface Backend {
  kind: Persistence['kind'];
  list: () => Promise<ThreadMeta[]>;
  get: (id: string) => Promise<Thread | null>;
  put: (thread: Thread) => Promise<void>;
  delete: (id: string) => Promise<void>;
}

const meta = (t: Thread): ThreadMeta => ({ id: t.id, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt });

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
      // datasets can be large: if the quota refuses them, keep the transcript at least
      if (!writeJson(ls, threadKey(t.id), t)) writeJson(ls, threadKey(t.id), { ...t, datasets: {} });
      writeJson(ls, listKey, [meta(t), ...list().filter((m) => m.id !== t.id)]);
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
      return req(db.transaction('threads').objectStore('threads').getAll() as IDBRequest<ThreadMeta[]>);
    },
    async get(id) {
      const db = await open();
      const tx = db.transaction(['threads', 'messages', 'datasets']);
      const [m, msgs, ds] = await Promise.all([
        req(tx.objectStore('threads').get(id) as IDBRequest<ThreadMeta | undefined>),
        req(tx.objectStore('messages').get(id) as IDBRequest<{ id: string; messages: Thread['messages'] } | undefined>),
        req(tx.objectStore('datasets').index('threadId').getAll(id) as IDBRequest<{ key: string; dataset: Dataset }[]>),
      ]);
      if (!m) return null;
      const datasets: Record<string, Dataset> = {};
      for (const d of ds) {
        datasets[d.dataset.id] = d.dataset;
        savedDatasets.add(d.key);
      }
      return { ...meta(m as Thread), messages: msgs?.messages ?? [], datasets };
    },
    async put(t) {
      const db = await open();
      const tx = db.transaction(['threads', 'messages', 'datasets'], 'readwrite');
      const finished = done(tx);
      const written: string[] = [];
      try {
        tx.objectStore('threads').put(meta(t));
        // structured clone refuses functions and the like a tool may have returned: store the JSON form then
        try {
          tx.objectStore('messages').put({ id: t.id, messages: t.messages });
        } catch {
          tx.objectStore('messages').put({ id: t.id, messages: plain(t.messages) });
        }
        for (const d of Object.values(t.datasets)) {
          const key = `${t.id}/${d.id}`;
          if (savedDatasets.has(key)) continue; // datasets never change once made
          tx.objectStore('datasets').put({ key, threadId: t.id, dataset: d });
          written.push(key);
        }
      } catch (e) {
        tx.abort();
        await finished.catch(() => {});
        throw e;
      }
      await finished;
      written.forEach((k) => savedDatasets.add(k));
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

/** Falls back to the next backend when a call fails (IndexedDB unavailable in a private window, quota…). */
function withFallback(primary: Backend, fallback: () => Backend): Backend {
  let active = primary;
  let failed = false;
  const run = async <T>(fn: (b: Backend) => Promise<T>): Promise<T> => {
    try {
      return await fn(active);
    } catch (e) {
      if (failed) throw e;
      failed = true;
      active = fallback();
      return fn(active);
    }
  };
  return {
    get kind() {
      return active.kind;
    },
    list: () => run((b) => b.list()),
    get: (id) => run((b) => b.get(id)),
    put: (t) => run((b) => b.put(t)),
    delete: (id) => run((b) => b.delete(id)),
  };
}

// ------------------------------------------------------------------ settings

type StoredKeys = Record<string, string>;

/** Creates the persistence for a storage namespace. `memory` keeps nothing across reloads (tests, demos). */
export function createPersistence(storageKey: string, mode: 'auto' | 'memory' = 'auto'): Persistence {
  const ls = mode === 'memory' ? null : storage('localStorage');
  const ss = mode === 'memory' ? null : storage('sessionStorage');
  const memSettings: { settings: Partial<AssistantSettings> | null; keys: StoredKeys; current: string | null } = { settings: null, keys: {}, current: null };
  const settingsKey = `${storageKey}.assistant.settings`;
  const keysKey = `${storageKey}.assistant.keys`;
  const currentKey = `${storageKey}.assistant.current`;

  let backend: Backend;
  const idb = mode === 'memory' ? undefined : (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const secondary = () => (ls ? localStorageBackend(ls, storageKey) : memoryBackend());
  if (idb) backend = withFallback(idbBackend(idb, `${storageKey}-assistant`), secondary);
  else backend = withFallback(secondary(), memoryBackend);

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
