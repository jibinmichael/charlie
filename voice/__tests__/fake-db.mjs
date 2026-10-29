// voice/__tests__/fake-db.mjs — an in-memory stand-in for the Supabase client, TEST ONLY.
//
// Implements the small subset of the query builder voice/store.mjs uses: from().select/insert/
// upsert/update/delete with eq/neq/in/order/limit/single, and storage.from().remove. It does NOT
// implement foreign-key cascades on purpose: the store deletes table by table, and the test proves
// the store does, not that Postgres would.
//
// Not a *.test.mjs file, so vitest never runs it directly.
import { randomUUID } from "node:crypto";

export function fakeDb(seed = {}) {
  const tables = new Map();
  const T = (name) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name); };
  for (const [name, rows] of Object.entries(seed)) T(name).push(...rows.map((r) => ({ ...r })));
  const removed = [];

  class Q {
    constructor(table) { this.table = table; this.filters = []; this.op = "select"; this._limit = null; this._orders = null; this._single = false; this._returning = true; }
    select() { if (this.op === "select") this._returning = true; this._select = true; return this; }
    insert(rows) { this.op = "insert"; this.rows = Array.isArray(rows) ? rows : [rows]; this._returning = false; return this; }
    upsert(rows, opts = {}) { this.op = "upsert"; this.rows = Array.isArray(rows) ? rows : [rows]; this.opts = opts; this._returning = false; return this; }
    update(patch) { this.op = "update"; this.patch = patch; this._returning = false; return this; }
    delete() { this.op = "delete"; this._returning = false; return this; }
    eq(k, v) { this.filters.push((r) => r[k] === v); return this; }
    neq(k, v) { this.filters.push((r) => r[k] !== v); return this; }
    in(k, vs) { this.filters.push((r) => vs.includes(r[k])); return this; }
    order(k, { ascending = true } = {}) { (this._orders ??= []).push({ k, ascending }); return this; }
    limit(n) { this._limit = n; return this; }
    range(from, to) { this._range = [from, to]; return this; }
    single() { this._single = true; return this; }
    _match() { return T(this.table).filter((r) => this.filters.every((f) => f(r))); }
    _finish(data) {
      if (this._orders) data = [...data].sort((a, b) => {
        for (const { k, ascending } of this._orders) {
          const c = (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (ascending ? 1 : -1);
          if (c !== 0) return c;
        }
        return 0;
      });
      if (this._range) data = data.slice(this._range[0], this._range[1] + 1);
      if (this._limit != null) data = data.slice(0, this._limit);
      if (this._single) return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: `expected one row, got ${data.length}` } };
      return { data, error: null };
    }
    then(resolve, reject) {
      try {
        const t = T(this.table);
        if (this.op === "select") return resolve(this._finish(this._match()));
        if (this.op === "insert") {
          const out = this.rows.map((r) => ({ id: r.id ?? randomUUID(), created_at: new Date().toISOString(), ...r }));
          t.push(...out);
          return resolve(this._select ? this._finish(out) : { data: null, error: null });
        }
        if (this.op === "upsert") {
          const keys = String(this.opts.onConflict || "id").split(",").map((s) => s.trim());
          const out = [];
          for (const r of this.rows) {
            const i = t.findIndex((x) => keys.every((k) => x[k] === r[k]));
            if (i >= 0) { if (!this.opts.ignoreDuplicates) t[i] = { ...t[i], ...r }; out.push(t[i]); }
            else { const row = { id: r.id ?? randomUUID(), created_at: new Date().toISOString(), ...r }; t.push(row); out.push(row); }
          }
          return resolve(this._select ? this._finish(out) : { data: null, error: null });
        }
        if (this.op === "update") {
          const hit = this._match();
          for (const r of hit) Object.assign(r, this.patch);
          return resolve(this._select ? this._finish(hit) : { data: null, error: null });
        }
        if (this.op === "delete") {
          const hit = new Set(this._match());
          tables.set(this.table, t.filter((r) => !hit.has(r)));
          return resolve({ data: null, error: null });
        }
        return resolve({ data: null, error: { message: `unsupported op ${this.op}` } });
      } catch (e) { return reject ? reject(e) : Promise.reject(e); }
    }
  }

  const uploaded = [];
  const buckets = new Set();
  return {
    from: (table) => new Q(table),
    storage: {
      from: () => ({
        remove: async (paths) => { removed.push(...paths); return { error: null }; },
        upload: async (path, body) => { uploaded.push({ path, size: body?.size ?? String(body).length, body }); return { data: { path }, error: null }; },
        download: async (path) => { const u = [...uploaded].reverse().find((x) => x.path === path); return u ? { data: u.body, error: null } : { data: null, error: { message: "not found" } }; },
      }),
      getBucket: async (name) => ({ data: buckets.has(name) ? { name } : null, error: null }),
      createBucket: async (name) => { buckets.add(name); return { data: { name }, error: null }; },
    },
    _tables: tables,
    _rows: (name) => T(name),
    _removed: removed,
    _uploaded: uploaded,
    _buckets: buckets,
  };
}
