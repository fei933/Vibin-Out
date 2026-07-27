/**
 * Lazy, cached Mongo connection.
 *
 * Nothing connects at import time — the module is loaded on every cold start
 * of the serverless function, and the home page must render with Mongo down.
 * The connection is established on first use and the promise is cached for
 * the life of the instance; a failed attempt clears the cache so the next
 * request retries rather than inheriting a dead promise.
 *
 * There are no models any more. v2 stores two things: immutable score
 * documents and rate-limit counters, both plain collections.
 */
import mongoose from 'mongoose';

export const SCORES_COLLECTION = 'scores';
export const RATE_LIMITS_COLLECTION = 'rate_limits';

export const SERVER_SELECTION_TIMEOUT_MS = 5000;
const MAX_POOL_SIZE = 10; // per instance; Atlas M0 caps the cluster at 500

let connectionPromise = null;
let indexesEnsured = false;

export function isConfigured() {
  return Boolean(process.env.MONGODB_URI);
}

export async function connect() {
  if (!isConfigured()) throw new Error('MONGODB_URI is not set');
  if (connectionPromise) return connectionPromise;

  connectionPromise = mongoose
    .connect(process.env.MONGODB_URI, {
      maxPoolSize: MAX_POOL_SIZE,
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    })
    .then((m) => m.connection)
    .catch((error) => {
      connectionPromise = null; // let the next request try again
      throw error;
    });

  return connectionPromise;
}

export async function getCollection(name) {
  const connection = await connect();
  if (!indexesEnsured) {
    indexesEnsured = true;
    ensureIndexes(connection).catch(() => {
      indexesEnsured = false; // harmless to retry later
    });
  }
  return connection.db.collection(name);
}

/** Best-effort; index creation must never block a request. */
async function ensureIndexes(connection) {
  await Promise.all([
    connection.db.collection(SCORES_COLLECTION).createIndex({ slug: 1 }, { unique: true }),
    connection.db
      .collection(RATE_LIMITS_COLLECTION)
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

export function scoresCollection() {
  return getCollection(SCORES_COLLECTION);
}

export function rateLimitsCollection() {
  return getCollection(RATE_LIMITS_COLLECTION);
}

export async function disconnect() {
  connectionPromise = null;
  indexesEnsured = false;
  await mongoose.disconnect();
}
