import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRateLimiter,
  GLOBAL_LIMIT,
  PER_IP_LIMIT,
  PER_IP_WINDOW_MS,
} from '../lib/rateLimiter.js';

/** An in-memory stand-in for the Mongo collection, with the same atomic shape. */
function fakeCollection() {
  const docs = new Map();
  return {
    docs,
    async findOneAndUpdate(filter, update) {
      const id = filter._id;
      const existing = docs.get(id) ?? { _id: id, count: 0 };
      existing.count += update.$inc.count;
      docs.set(id, existing);
      return existing;
    },
    async updateOne(filter, update) {
      const doc = docs.get(filter._id);
      if (!doc) return { matchedCount: 0 };
      if (filter.count?.$gt !== undefined && !(doc.count > filter.count.$gt)) {
        return { matchedCount: 0 };
      }
      doc.count += update.$inc.count;
      return { matchedCount: 1 };
    },
  };
}

const limiterOver = (collection, overrides = {}) =>
  createRateLimiter({ getCollection: async () => collection, ...overrides });

test('allows requests up to the per-IP limit, then cools down', async () => {
  const collection = fakeCollection();
  const limiter = limiterOver(collection);

  for (let i = 0; i < PER_IP_LIMIT; i += 1) {
    const gate = await limiter.check('1.2.3.4');
    assert.equal(gate.allowed, true, `request ${i + 1} should be allowed`);
  }

  const blocked = await limiter.check('1.2.3.4');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'cooldown');
  assert.equal(blocked.scope, 'ip');
});

test('per-IP windows are independent between visitors', async () => {
  const collection = fakeCollection();
  const limiter = limiterOver(collection);

  for (let i = 0; i < PER_IP_LIMIT; i += 1) await limiter.check('1.1.1.1');
  assert.equal((await limiter.check('1.1.1.1')).allowed, false);
  assert.equal((await limiter.check('9.9.9.9')).allowed, true);
});

test('a fresh window lets a throttled visitor back in', async () => {
  const collection = fakeCollection();
  let clock = 0;
  const limiter = limiterOver(collection, { now: () => clock });

  for (let i = 0; i < PER_IP_LIMIT; i += 1) await limiter.check('1.2.3.4');
  assert.equal((await limiter.check('1.2.3.4')).allowed, false);

  clock += PER_IP_WINDOW_MS;
  assert.equal((await limiter.check('1.2.3.4')).allowed, true);
});

test('the global daily cap stops everyone, and refunds the visitor their slot', async () => {
  const collection = fakeCollection();
  const limiter = limiterOver(collection, { perIpLimit: 1000, globalLimit: 2 });

  assert.equal((await limiter.check('a')).allowed, true);
  assert.equal((await limiter.check('b')).allowed, true);

  const blocked = await limiter.check('c');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, 'global');

  const ipDoc = [...collection.docs.values()].find((d) => d._id.startsWith('ip:c'));
  assert.equal(ipDoc.count, 0, 'a global cap must not consume the visitor’s hourly slot');
  assert.ok(GLOBAL_LIMIT > 2, 'sanity: the shipped cap is higher than this test’s');
});

test('FAILS CLOSED when the store is unreachable', async () => {
  const unreachable = createRateLimiter({
    getCollection: async () => {
      throw new Error('MongooseServerSelectionError');
    },
  });
  const gate = await unreachable.check('1.2.3.4');
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'cooldown');
  assert.equal(gate.scope, 'store_unavailable');

  const brokenWrites = limiterOver({
    async findOneAndUpdate() {
      throw new Error('not primary');
    },
    async updateOne() {},
  });
  assert.equal((await brokenWrites.check('1.2.3.4')).allowed, false);
});

test('refunding a failed generation gives the slot back, and is idempotent', async () => {
  const collection = fakeCollection();
  const limiter = limiterOver(collection);

  const gate = await limiter.check('1.2.3.4');
  const key = [...collection.docs.keys()].find((k) => k.startsWith('ip:1.2.3.4'));
  assert.equal(collection.docs.get(key).count, 1);

  await gate.refund();
  assert.equal(collection.docs.get(key).count, 0);

  await gate.refund();
  assert.equal(collection.docs.get(key).count, 0, 'a double refund must not mint free quota');
});
