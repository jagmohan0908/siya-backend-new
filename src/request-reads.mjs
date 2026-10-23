import {AsyncLocalStorage} from 'node:async_hooks';

// Lifetime is one HTTP request, not a user session or a process-wide cache.
// The next request always rechecks current ERP permissions and patient links.
const scopes = new AsyncLocalStorage();
export const withErpReadScope = action => scopes.run(new Map(), action);

export async function requestRead(client, path, options, load) {
  const scope = scopes.getStore();
  if (!scope) return load();
  const method = options.method ?? 'GET';
  // Custom ERP methods can mutate records even when invoked with GET.
  if (method !== 'GET' || !path.startsWith('/api/resource/')) {
    scope.delete(client);
    try { return await load(); }
    finally { scope.delete(client); }
  }
  // File streams must be independently consumable by each caller.
  if (options.raw) return load();
  let reads = scope.get(client);
  if (!reads) { reads = new Map(); scope.set(client, reads); }
  const key = JSON.stringify([path, options.timeoutMs ?? 25000]);
  let pending = reads.get(key);
  if (!pending) {
    if (reads.size >= 128) return load();
    pending = load();
    reads.set(key, pending);
    pending.catch(() => { if (reads.get(key) === pending) reads.delete(key); });
  }
  // Callers can modify a document without changing another caller's snapshot.
  return structuredClone(await pending);
}
