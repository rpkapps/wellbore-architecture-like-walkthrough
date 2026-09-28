import { describe, expect, it } from 'vitest';
import { createPersistence, TRIM_ROWS } from '../../src/assistant/core/persistence';
import type { Dataset, Thread } from '../../src/assistant/core/types';
import { fakeIndexedDB, fakeStorage } from './core-fake-storage';

const thread = (id: string, updatedAt: number, datasets: Dataset[] = []): Thread => ({
  id,
  title: `Chat ${id}`,
  createdAt: 1,
  updatedAt,
  messages: [
    { id: `${id}_q`, role: 'user', parts: [{ type: 'text', text: 'Q' }], createdAt: 1 },
    { id: `${id}_a`, role: 'assistant', parts: [{ type: 'tool-call', id: `${id}_c`, name: 'x', args: {}, state: 'done', datasets: datasets.map((d) => d.id) }], createdAt: 2 },
  ],
  datasets: Object.fromEntries(datasets.map((d) => [d.id, d])),
});
const dataset = (id: string, rows: number): Dataset => ({ id, title: id, columns: [{ key: 'v' }], rows: Array.from({ length: rows }, (_, i) => ({ v: i })), createdAt: 0 });

function stores() {
  const idb = fakeIndexedDB();
  const ls = fakeStorage();
  const storages = { indexedDB: idb.indexedDB, localStorage: ls, sessionStorage: null };
  const open = () => createPersistence('app', 'auto', storages);
  const saved = async (p: ReturnType<typeof open>, t: Thread) => {
    p.saveThread(t);
    await p.flush();
  };
  const inIdb = (id: string) => idb.control.dbs.get('app-assistant')!.get('threads')!.rows.has(id);
  const inLs = (id: string) => ls.data.has(`app.assistant.thread.${id}`);
  return { idb, ls, open, saved, inIdb, inLs };
}

describe('thread storage', () => {
  it('keeps a thread’s summaries, tool mode and found tools across a reload', async () => {
    const { open, saved } = stores();
    const t: Thread = {
      ...thread('s', 1),
      compactions: [{ id: 'c1', throughMessageId: 's_a', summary: 'Goal: GR.', createdAt: 3, auto: true, messages: 2, tokensBefore: 9000, tokensAfter: 1200 }],
      toolMode: { connection: 'p1|m', deferred: true },
      enabledTools: ['view.color_by'],
    };
    await saved(open(), t);
    const back = (await open().loadThread('s'))!;
    expect(back.compactions).toEqual(t.compactions);
    expect(back.toolMode).toEqual(t.toolMode);
    expect(back.enabledTools).toEqual(['view.color_by']);
  });

  it('one refused IndexedDB save goes to localStorage alone: the other threads stay readable and deletable in IndexedDB', async () => {
    const { idb, open, saved, inIdb, inLs } = stores();
    const p = open();
    await saved(p, thread('a', 1));
    idb.control.failPuts = true;
    await saved(p, thread('b', 1));
    idb.control.failPuts = false;
    expect(inIdb('a') && !inIdb('b') && inLs('b')).toBe(true);
    // IndexedDB is still used for everything else
    await saved(p, thread('a', 2));
    expect(inLs('a')).toBe(false);
    expect((await p.listThreads()).map((m) => m.id).sort()).toEqual(['a', 'b']);
    expect((await p.loadThread('a'))!.updatedAt).toBe(2);

    // after a reload both are found, wherever they were saved
    const q = open();
    expect((await q.listThreads()).map((m) => m.id).sort()).toEqual(['a', 'b']);
    expect((await q.loadThread('b'))!.messages).toHaveLength(2);
    await q.deleteThread('a');
    expect(inIdb('a')).toBe(false);
    // saved to IndexedDB again, the stale fallback copy goes
    await saved(q, thread('b', 3));
    expect(inIdb('b') && !inLs('b')).toBe(true);
    await q.deleteThread('b');
    expect(await open().listThreads()).toEqual([]);
  });

  it('reads the newer copy when a thread is in both stores', async () => {
    const { idb, open, saved } = stores();
    const p = open();
    await saved(p, thread('a', 1));
    idb.control.failPuts = true;
    await saved(p, { ...thread('a', 5), title: 'Newer' });
    idb.control.failPuts = false;
    const q = open();
    expect((await q.listThreads())[0]).toMatchObject({ id: 'a', title: 'Newer', updatedAt: 5 });
    expect((await q.loadThread('a'))!.title).toBe('Newer');
  });

  it('when the quota is full, saves the thread without the rows of large datasets before falling back', async () => {
    const { idb, open, saved, inIdb, inLs } = stores();
    const big = dataset('ds_2', TRIM_ROWS + 500);
    const t = thread('a', 1, [dataset('ds_1', 3), big]);
    idb.control.quota = JSON.stringify(big.rows).length; // the big dataset alone does not fit
    await saved(open(), t);
    expect(inIdb('a') && !inLs('a')).toBe(true);
    const back = (await open().loadThread('a'))!;
    expect(back.datasets.ds_1.rows).toHaveLength(3);
    expect(back.datasets.ds_2).toMatchObject({ rows: [], trimmed: { rowCount: TRIM_ROWS + 500 } });
  });

  it('deletes the datasets a thread no longer has, and keeps its dataset counter', async () => {
    const { idb, open, saved } = stores();
    const p = open();
    await saved(p, thread('a', 1, [dataset('ds_1', 2), dataset('ds_2', 2)]));
    await saved(p, { ...thread('a', 2, [dataset('ds_1', 2), dataset('ds_3', 4)]), nextDatasetSeq: 4 });
    expect([...idb.control.dbs.get('app-assistant')!.get('datasets')!.rows.keys()].sort()).toEqual(['a/ds_1', 'a/ds_3']);
    const back = (await open().loadThread('a'))!;
    expect(Object.keys(back.datasets).sort()).toEqual(['ds_1', 'ds_3']);
    expect(back.datasets.ds_3.rows).toHaveLength(4);
    expect(back.nextDatasetSeq).toBe(4);
  });
});
