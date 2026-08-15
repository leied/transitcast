import type { Brief } from '$lib/types';

const DB_NAME = 'transitcast';
const DB_VERSION = 1;
const AUDIO = 'audio';
const BRIEFS = 'briefs';

export type StoredAudio = {
	id: string;
	blob: Blob;
	engine: string;
	createdAt: string;
	chars: number;
};

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO, { keyPath: 'id' });
			if (!db.objectStoreNames.contains(BRIEFS)) db.createObjectStore(BRIEFS, { keyPath: 'id' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
	return open().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const t = db.transaction(store, mode);
				const req = fn(t.objectStore(store));
				req.onsuccess = () => resolve(req.result as T);
				req.onerror = () => reject(req.error);
				t.oncomplete = () => db.close();
			})
	);
}

/**
 * Rendered audio lives here and nowhere else. Keeping it on the device is what
 * removes the need for object storage on the server, and it's also what makes
 * the brief playable with no signal on the bus.
 */
export const audioStore = {
	get: (id: string) => tx<StoredAudio | undefined>(AUDIO, 'readonly', (s) => s.get(id)),
	put: (value: StoredAudio) => tx<IDBValidKey>(AUDIO, 'readwrite', (s) => s.put(value)),
	delete: (id: string) => tx<undefined>(AUDIO, 'readwrite', (s) => s.delete(id)),
	keys: () => tx<IDBValidKey[]>(AUDIO, 'readonly', (s) => s.getAllKeys()),
	all: () => tx<StoredAudio[]>(AUDIO, 'readonly', (s) => s.getAll())
};

export const briefStore = {
	get: (id: string) => tx<Brief | undefined>(BRIEFS, 'readonly', (s) => s.get(id)),
	put: (brief: Brief) => tx<IDBValidKey>(BRIEFS, 'readwrite', (s) => s.put(brief)),
	all: () => tx<Brief[]>(BRIEFS, 'readonly', (s) => s.getAll()),
	delete: (id: string) => tx<undefined>(BRIEFS, 'readwrite', (s) => s.delete(id))
};

/** Keep the most recent few briefs and bin the rest, audio included. */
export async function pruneTo(keep = 5): Promise<void> {
	const briefs = await briefStore.all();
	briefs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	for (const stale of briefs.slice(keep)) {
		await briefStore.delete(stale.id);
		await audioStore.delete(stale.id);
	}
}
