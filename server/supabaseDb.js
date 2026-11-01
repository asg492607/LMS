import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabaseAdminAuth } from './supabaseAuth.js';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const moduleDir = dirname(fileURLToPath(import.meta.url));
const serverDbConfigured = Boolean(
  process.env.SUPABASE_DB_HOST && process.env.SUPABASE_DB_USER && process.env.SUPABASE_DB_PASSWORD,
);
const caPath = resolve(moduleDir, 'certs/supabase-root-ca.crt');

let pool = null;
if (serverDbConfigured) {
  let ca;
  try {
    ca = readFileSync(caPath, 'utf8');
  } catch {
    throw new Error('The Supabase Postgres CA certificate is missing from server/certs.');
  }
  pool = new Pool({
    host: process.env.SUPABASE_DB_HOST,
    port: Number(process.env.SUPABASE_DB_PORT || 5432),
    user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
    database: process.env.SUPABASE_DB_NAME || 'postgres',
    ssl: { ca, rejectUnauthorized: true },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

const SERVER_TIMESTAMP = Symbol('server-timestamp');

export const FieldValue = Object.freeze({ serverTimestamp: () => SERVER_TIMESTAMP });

export class Timestamp {
  constructor(value) {
    this.value = new Date(value);
  }

  toDate() {
    return new Date(this.value);
  }

  toMillis() {
    return this.value.getTime();
  }

  toJSON() {
    return this.value.toISOString();
  }

  static fromDate(value) {
    return new Timestamp(value);
  }
}

function normalizeValue(value) {
  if (value === SERVER_TIMESTAMP) return new Date().toISOString();
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]));
  }
  return value;
}

function hydrateValue(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => hydrateValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, hydrateValue(item, childKey)]));
  }
  if (typeof value === 'string' && /(At|Date)$/.test(key) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    return new Timestamp(value);
  }
  return value;
}

function uuid() {
  return randomUUID().replaceAll('-', '');
}

class DocumentSnapshot {
  constructor(ref, row) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = Boolean(row);
    this._data = row?.data ?? null;
  }

  data() {
    return this._data ? hydrateValue(this._data) : undefined;
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
  }
}

class CountSnapshot {
  constructor(count) {
    this._count = Number(count) || 0;
  }

  data() {
    return { count: this._count };
  }
}

class DocumentReference {
  constructor(collectionName, id) {
    this.collectionName = collectionName;
    this.id = id;
  }

  get parent() {
    return new CollectionReference(this.collectionName);
  }

  collection(name) {
    return new CollectionReference(`${this.collectionName}/${this.id}/${name}`);
  }

  async get() {
    const result = await pool.query(
      'select data from public.lms_documents where collection_name = $1 and document_id = $2',
      [this.collectionName, this.id],
    );
    return new DocumentSnapshot(this, result.rows[0]);
  }

  async set(data, options = {}) {
    const value = normalizeValue(data || {});
    const merge = options?.merge === true;
    await pool.query(
      `insert into public.lms_documents (collection_name, document_id, parent_document_id, data)
       values ($1, $2, $3, $4::jsonb)
       on conflict (collection_name, document_id) do update
         set data = ${merge ? 'public.lms_documents.data || excluded.data' : 'excluded.data'},
             updated_at = now()`,
      [this.collectionName, this.id, parentDocumentId(this.collectionName), JSON.stringify(value)],
    );
  }

  async create(data) {
    try {
      await pool.query(
        'insert into public.lms_documents (collection_name, document_id, parent_document_id, data) values ($1, $2, $3, $4::jsonb)',
        [this.collectionName, this.id, parentDocumentId(this.collectionName), JSON.stringify(normalizeValue(data || {}))],
      );
    } catch (error) {
      if (error?.code === '23505') error.code = 'already-exists';
      throw error;
    }
  }

  async update(data) {
    const result = await pool.query(
      'update public.lms_documents set data = data || $3::jsonb, updated_at = now() where collection_name = $1 and document_id = $2',
      [this.collectionName, this.id, JSON.stringify(normalizeValue(data || {}))],
    );
    if (!result.rowCount) {
      const error = new Error('Document does not exist.');
      error.code = 'not-found';
      throw error;
    }
  }

  async delete() {
    await pool.query(
      'delete from public.lms_documents where collection_name = $1 and document_id = $2',
      [this.collectionName, this.id],
    );
  }
}

function parentDocumentId(collectionName) {
  const pieces = collectionName.split('/');
  return pieces.length >= 3 ? pieces[pieces.length - 2] : null;
}

class Query {
  constructor(collectionName, { group = false, filters = [], rowLimit = 1000, order = null } = {}) {
    this.collectionName = collectionName;
    this.group = group;
    this.filters = filters;
    this.rowLimit = rowLimit;
    this.order = order;
  }

  where(field, operator, value) {
    if (!['==', '!=', '>', '>=', '<', '<='].includes(operator)) {
      throw new Error(`Unsupported database filter operator: ${operator}`);
    }
    return new Query(this.collectionName, {
      group: this.group,
      filters: [...this.filters, { field, operator, value }],
      rowLimit: this.rowLimit,
      order: this.order,
    });
  }

  limit(value) {
    const number = Number(value);
    return new Query(this.collectionName, {
      group: this.group,
      filters: this.filters,
      rowLimit: Math.max(1, Math.min(1000, Number.isFinite(number) ? Math.trunc(number) : 1000)),
      order: this.order,
    });
  }

  orderBy(field, direction = 'asc') {
    return new Query(this.collectionName, {
      group: this.group,
      filters: this.filters,
      rowLimit: this.rowLimit,
      order: { field, direction: String(direction).toLowerCase() === 'desc' ? 'desc' : 'asc' },
    });
  }

  count() {
    return { get: async () => {
      const { sql, values } = this.buildSql(true);
      const result = await pool.query(sql, values);
      return new CountSnapshot(result.rows[0]?.count);
    } };
  }

  buildSql(countOnly = false) {
    const values = [];
    const predicates = [];
    if (this.group) {
      values.push(this.collectionName);
      predicates.push(`(collection_name = $${values.length} or collection_name like '%/' || $${values.length})`);
    } else {
      values.push(this.collectionName);
      predicates.push(`collection_name = $${values.length}`);
    }
    for (const filter of this.filters) {
      const path = String(filter.field).split('.').filter(Boolean);
      values.push(path);
      const jsonPathParam = `$${values.length}::text[]`;
      values.push(JSON.stringify(normalizeValue(filter.value)));
      const valueParam = `$${values.length}::jsonb`;
      const operator = filter.operator === '==' ? '=' : filter.operator;
      predicates.push(`data #> ${jsonPathParam} ${operator} ${valueParam}`);
    }
    const where = predicates.join(' and ');
    if (countOnly) return { sql: `select count(*)::int as count from public.lms_documents where ${where}`, values };
    let orderBy = 'created_at asc';
    if (this.order) {
      values.push(String(this.order.field).split('.').filter(Boolean));
      orderBy = `data #>> $${values.length}::text[] ${this.order.direction}`;
    }
    values.push(this.rowLimit);
    return {
      sql: `select collection_name, document_id, parent_document_id, data
              from public.lms_documents
             where ${where}
             order by ${orderBy}
             limit $${values.length}`,
      values,
    };
  }

  async get() {
    const { sql, values } = this.buildSql();
    const result = await pool.query(sql, values);
    const docs = result.rows.map((row) => new DocumentSnapshot(new DocumentReference(row.collection_name, row.document_id), row));
    return new QuerySnapshot(docs);
  }
}

class CollectionReference extends Query {
  constructor(name) {
    super(name);
    this.id = name.split('/').at(-1);
  }

  doc(id = uuid()) {
    return new DocumentReference(this.collectionName, String(id));
  }

  get parent() {
    const parts = this.collectionName.split('/');
    if (parts.length < 3) return null;
    const parentId = parts.at(-2);
    const parentCollection = parts.slice(0, -2).join('/');
    return new DocumentReference(parentCollection, parentId);
  }
}

class TransactionDocumentSnapshot extends DocumentSnapshot {}

class Database {
  collection(name) {
    return new CollectionReference(name);
  }

  collectionGroup(name) {
    return new Query(String(name), { group: true });
  }

  async getAll(...refs) {
    return Promise.all(refs.map((ref) => ref.get()));
  }

  async runTransaction(callback) {
    const client = await pool.connect();
    const writes = [];
    try {
      await client.query('begin');
      const transaction = {
        get: async (ref) => {
          const result = await client.query(
            'select data from public.lms_documents where collection_name = $1 and document_id = $2 for update',
            [ref.collectionName, ref.id],
          );
          return new TransactionDocumentSnapshot(ref, result.rows[0]);
        },
        create: (ref, data) => writes.push({ kind: 'create', ref, data }),
        set: (ref, data, options) => writes.push({ kind: 'set', ref, data, options }),
        update: (ref, data) => writes.push({ kind: 'update', ref, data }),
        delete: (ref) => writes.push({ kind: 'delete', ref }),
      };
      const value = await callback(transaction);
      for (const write of writes) {
        const { ref } = write;
        if (write.kind === 'create') {
          await client.query(
            'insert into public.lms_documents (collection_name, document_id, parent_document_id, data) values ($1, $2, $3, $4::jsonb)',
            [ref.collectionName, ref.id, parentDocumentId(ref.collectionName), JSON.stringify(normalizeValue(write.data || {}))],
          );
        } else if (write.kind === 'set') {
          const value = normalizeValue(write.data || {});
          await client.query(
            `insert into public.lms_documents (collection_name, document_id, parent_document_id, data)
             values ($1, $2, $3, $4::jsonb)
             on conflict (collection_name, document_id) do update
               set data = ${write.options?.merge === true ? 'public.lms_documents.data || excluded.data' : 'excluded.data'},
                   updated_at = now()`,
            [ref.collectionName, ref.id, parentDocumentId(ref.collectionName), JSON.stringify(value)],
          );
        } else if (write.kind === 'update') {
          const result = await client.query(
            'update public.lms_documents set data = data || $3::jsonb, updated_at = now() where collection_name = $1 and document_id = $2',
            [ref.collectionName, ref.id, JSON.stringify(normalizeValue(write.data || {}))],
          );
          if (!result.rowCount) {
            const error = new Error('Document does not exist.');
            error.code = 'not-found';
            throw error;
          }
        } else if (write.kind === 'delete') {
          await client.query('delete from public.lms_documents where collection_name = $1 and document_id = $2', [ref.collectionName, ref.id]);
        }
      }
      await client.query('commit');
      return value;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      if (error?.code === '23505') error.code = 'already-exists';
      throw error;
    } finally {
      client.release();
    }
  }
}

export const adminDb = pool ? new Database() : null;
export const dbConfigured = Boolean(adminDb);
export const UNIVERSITY_ID = process.env.UNIVERSITY_ID || 'mit-adt';
export const UNIVERSITY_NAME = process.env.UNIVERSITY_NAME || 'MIT ADT University';

function toAuthUser(user) {
  return {
    uid: user.id,
    email: user.email,
    displayName: user.user_metadata?.display_name || user.user_metadata?.full_name || '',
    emailVerified: Boolean(user.email_confirmed_at || user.confirmed_at),
    mustChangePassword: user.app_metadata?.must_change_password === true,
    disabled: Boolean(user.banned_until),
  };
}

function normalizeAuthAdminError(error) {
  if (error?.code === 'email_exists' || error?.code === 'user_already_exists' || error?.status === 422) {
    const duplicate = new Error('A Supabase Auth account already exists for this email.');
    duplicate.code = 'already-exists';
    return duplicate;
  }
  return error;
}

export const adminAuth = supabaseAdminAuth ? {
  async getUserByEmail(email) {
    const perPage = 1000;
    for (let page = 1; ; page += 1) {
      const { data, error } = await supabaseAdminAuth.auth.admin.listUsers({ page, perPage });
      if (error) throw error;
      const user = data.users.find((item) => item.email?.toLowerCase() === String(email).toLowerCase());
      if (user) return toAuthUser(user);
      if (data.users.length < perPage) break;
    }
    const missing = new Error('Supabase Auth user not found.');
    missing.code = 'auth/user-not-found';
    throw missing;
  },
  async createUser({ email, displayName, password }) {
    const { data, error } = await supabaseAdminAuth.auth.admin.createUser({
      email: String(email).toLowerCase(),
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName, full_name: displayName },
      app_metadata: { must_change_password: true },
    });
    if (error) throw normalizeAuthAdminError(error);
    return toAuthUser(data.user);
  },
  async updateInitialPassword(uid, password, appMetadata = {}) {
    const { data, error } = await supabaseAdminAuth.auth.admin.updateUserById(uid, {
      password,
      app_metadata: { ...appMetadata, must_change_password: false },
    });
    if (error) throw error;
    return toAuthUser(data.user);
  },
  async deleteUser(uid) {
    const { error } = await supabaseAdminAuth.auth.admin.deleteUser(uid);
    if (error) throw error;
  },
} : null;

export const dbPool = pool;
