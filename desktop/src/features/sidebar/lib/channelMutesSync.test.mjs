import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import { ChannelMuteSyncManager } from "./channelMutesSync.ts";
import {
  installFakeWindow,
  installTauriMock,
  makeFakeWindow,
} from "./sidebarSyncTestHelpers.mjs";

const RELAY = "wss://r.test";
const RELAY_KEY = encodeURIComponent(RELAY);

function makeStore(channels = {}) {
  return { version: 1, channels };
}
const E = (muted, updatedAt, rev) => ({ muted, updatedAt, rev });

// Multi-slot timer fake keyed by delay, for overlapping-publish tests. Mirrors
// the sections suite convention (channelSectionsSync.test.mjs:407-432).
function makeMultiTimerWindow() {
  const storage = new Map();
  const timers = new Map();
  let nextId = 1;
  const win = {
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  return {
    win,
    storage,
    timers,
    fireDelay: async (ms) => {
      const entry = [...timers.entries()].find(([, v]) => v.ms === ms);
      assert.ok(entry, `expected a timer scheduled at ${ms}ms`);
      timers.delete(entry[0]);
      entry[1].fn();
      for (let i = 0; i < 50; i++) await Promise.resolve();
    },
    hasDelay: (ms) => [...timers.values()].some((t) => t.ms === ms),
  };
}

// ─── observe() / high-water ingestion ─────────────────────────────────────────

test("observe: high-water is per-channel max of rev and updatedAt, monotonic", () => {
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const m = new ChannelMuteSyncManager("pk", RELAY);
    m.observe(makeStore({ a: E(true, 100, 3), b: E(false, 50, 1) }));
    assert.equal(m.maxRevSeen("a"), 3);
    assert.equal(m.maxUpdatedAtSeen("a"), 100);
    // A later observation raises each dimension independently; a lower one
    // never regresses either.
    m.observe(makeStore({ a: E(true, 90, 5) }));
    assert.equal(m.maxRevSeen("a"), 5, "rev raised");
    assert.equal(m.maxUpdatedAtSeen("a"), 100, "updatedAt not regressed");
    m.observe(makeStore({ a: E(true, 200, 2) }));
    assert.equal(m.maxUpdatedAtSeen("a"), 200, "updatedAt raised");
    assert.equal(m.maxRevSeen("a"), 5, "rev not regressed");
    // Unseen channel reports zero on both dimensions.
    assert.equal(m.maxRevSeen("never"), 0);
    assert.equal(m.maxUpdatedAtSeen("never"), 0);
  } finally {
    restore();
  }
});

// ─── destroy() must cancel pending publish, not flush ─────────────────────────

test("destroy: cancels pending publish without flushing to the relay", () => {
  const publishCalls = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", (...args) => {
    publishCalls.push(args);
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelMuteSyncManager("pk-test", RELAY);
    manager.publishMutes(makeStore({ ch1: E(true, 100, 1) }));
    manager.destroy();
    assert.equal(publishCalls.length, 0, "no publish after destroy");
    assert.equal(manager.getPendingMuteStore(), null);
  } finally {
    restore();
    mock.reset();
  }
});

test("destroy: aborts in-flight doPublish after fetchOwnBlobBeforePublish resolves", async () => {
  let releaseFetch = null;
  const publishCalls = [];
  mock.method(
    relayClient,
    "fetchEvents",
    () =>
      new Promise((res) => {
        releaseFetch = () => res([]);
      }),
  );
  mock.method(relayClient, "publishEvent", (...args) => {
    publishCalls.push(args);
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelMuteSyncManager("pk-race", RELAY);
    manager.publishMutes(makeStore({ ch1: E(true, 100, 1) }));
    fw._fireTimer();
    manager.destroy();
    releaseFetch();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(
      publishCalls.length,
      0,
      "publishEvent must not be called after destroy",
    );
  } finally {
    restore();
    mock.reset();
  }
});

test("destroy: is safe to call with no pending publish", () => {
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelMuteSyncManager("pk-no-pending", RELAY);
    assert.doesNotThrow(() => manager.destroy());
  } finally {
    restore();
  }
});

// ─── Generation CAS: A-in-flight → B-click → A-completes (both variants) ──────

// Finding 2 (A succeeds): an older in-flight publish that completes after a
// newer edit is queued must NOT clear the newer edit's pending store/outbox,
// and B must reach the relay via the completion re-drive. Mutation: dropping the
// generation CAS in discardPending lets A's success null out B's pending+outbox.
test("A-in-flight → B-click → A-succeeds: B stays pending and B publishes", async () => {
  let releaseFirst = null;
  const publishedContents = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", () => {
    if (releaseFirst === null && publishedContents.length === 0) {
      return new Promise((res) => {
        releaseFirst = res;
      });
    }
    return Promise.resolve();
  });
  const t = makeMultiTimerWindow();
  const restore = installFakeWindow(t.win);
  const tauri = installTauriMock("{}");
  const outboxKey = `buzz-channel-mutes-outbox.v1:pk-ab:${RELAY_KEY}`;
  try {
    const manager = new ChannelMuteSyncManager("pk-ab", RELAY);
    const storeA = makeStore({ a: E(true, 100, 1) });
    const storeB = makeStore({ b: E(true, 101, 1) });

    manager.publishMutes(storeA);
    await t.fireDelay(2000); // doPublish(A) awaits publishEvent
    while (releaseFirst === null) await Promise.resolve();

    // B arrives while A is in flight.
    manager.publishMutes(storeB);
    assert.deepEqual(
      Object.keys(manager.getPendingMuteStore().channels),
      ["b"],
      "B is now pending",
    );
    assert.ok(t.storage.get(outboxKey), "outbox holds B");

    // A completes — must NOT clear B.
    releaseFirst();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    assert.deepEqual(
      Object.keys(manager.getPendingMuteStore()?.channels ?? {}),
      ["b"],
      "older A completion leaves B pending",
    );
    assert.ok(t.storage.get(outboxKey), "older A completion leaves B outbox");

    // B's own debounce fires and B reaches the relay (published) with no kick.
    const capturedBefore = tauri.capturedPlaintext();
    await t.fireDelay(2000);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const captured = tauri.capturedPlaintext();
    assert.ok(
      captured && captured !== capturedBefore && captured.includes('"b"'),
      "B is published to the relay",
    );
    assert.equal(
      manager.getPendingMuteStore(),
      null,
      "B cleared after publish",
    );
    assert.equal(t.storage.get(outboxKey), undefined, "B outbox cleared");
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// Finding 2 (A fails): A's publish rejects after B is queued. B must remain
// pending and be published by the serialized re-drive / retry — no manual kick.
test("A-in-flight → B-click → A-fails: B remains pending and B publishes", async () => {
  let rejectFirst = null;
  let publishCount = 0;
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", () => {
    publishCount++;
    if (publishCount === 1) {
      return new Promise((_res, rej) => {
        rejectFirst = () => rej(new Error("socket error"));
      });
    }
    return Promise.resolve();
  });
  const t = makeMultiTimerWindow();
  const restore = installFakeWindow(t.win);
  const tauri = installTauriMock("{}");
  const outboxKey = `buzz-channel-mutes-outbox.v1:pk-abfail:${RELAY_KEY}`;
  try {
    const manager = new ChannelMuteSyncManager("pk-abfail", RELAY);
    manager.publishMutes(makeStore({ a: E(true, 100, 1) }));
    await t.fireDelay(2000);
    while (rejectFirst === null) await Promise.resolve();

    manager.publishMutes(makeStore({ b: E(true, 101, 1) }));
    rejectFirst(); // A fails
    for (let i = 0; i < 50; i++) await Promise.resolve();

    assert.deepEqual(
      Object.keys(manager.getPendingMuteStore()?.channels ?? {}),
      ["b"],
      "B still pending after A's failure",
    );
    assert.ok(t.storage.get(outboxKey), "B outbox intact after A's failure");

    // B's debounce fires and B publishes successfully.
    await t.fireDelay(2000);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const captured = tauri.capturedPlaintext();
    assert.ok(captured?.includes('"b"'), "B published");
    assert.equal(manager.getPendingMuteStore(), null, "B cleared");
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Bounded-backoff retry: failed publish on a healthy socket, no later edit ─

// Finding 2: a transient publish failure with the socket open and NO further
// click must self-heal via the bounded-backoff retry — the pending edit is kept
// and a retry timer is scheduled. Mutation: dropping scheduleRetry leaves the
// edit stranded (Will's "make another change to kick it" symptom).
test("failed publish schedules a bounded-backoff retry and keeps the pending edit", async () => {
  let publishCount = 0;
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", () => {
    publishCount++;
    if (publishCount === 1) return Promise.reject(new Error("timeout"));
    return Promise.resolve();
  });
  const t = makeMultiTimerWindow();
  const restore = installFakeWindow(t.win);
  const tauri = installTauriMock("{}");
  try {
    const manager = new ChannelMuteSyncManager("pk-retry", RELAY);
    manager.publishMutes(makeStore({ a: E(true, 100, 1) }));
    await t.fireDelay(2000); // debounce → doPublish → publishEvent rejects
    assert.ok(
      manager.getPendingMuteStore() !== null,
      "pending edit retained after failure",
    );
    assert.ok(t.hasDelay(2000), "a retry timer at RETRY_BASE_MS is scheduled");

    // The retry fires and the second publish succeeds → pending cleared.
    await t.fireDelay(2000);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    assert.equal(publishCount, 2, "retry re-published");
    assert.equal(
      manager.getPendingMuteStore(),
      null,
      "pending cleared on retry success",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// ─── Boot seed-publish guard (the revert-fix regression suite) ─────────────────

test("revert-fix: fetch failed (error) does not trigger seed-publish via bootstrap", async () => {
  mock.method(relayClient, "fetchEvents", () =>
    Promise.reject(new Error("relay timeout")),
  );
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelMuteSyncManager("pk-fail", RELAY);
    const result = await manager.bootstrap(makeStore({ ch1: E(true, 1, 0) }));
    assert.equal(result.action, "hold");
    assert.equal(manager.getPendingMuteStore(), null);
  } finally {
    restore();
    mock.reset();
  }
});

test("revert-fix: absent fetch with prior watermark blocks seed-publish via bootstrap", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  fw.localStorage.setItem(
    `buzz-sync-watermark.v1:channel-mutes:pk-stale:${RELAY_KEY}`,
    "1700000000",
  );
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelMuteSyncManager("pk-stale", RELAY);
    const result = await manager.bootstrap(makeStore({ ch1: E(true, 1, 0) }));
    assert.equal(result.action, "hold");
    assert.equal(manager.getPendingMuteStore(), null);
  } finally {
    restore();
    mock.reset();
  }
});

test("revert-fix: absent fetch with zero watermark seeds via bootstrap (first-sync preserved)", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelMuteSyncManager("pk-fresh", RELAY);
    const result = await manager.bootstrap(makeStore({ ch1: E(true, 1, 0) }));
    assert.equal(result.action, "hold");
    assert.ok(manager.getPendingMuteStore() !== null);
  } finally {
    restore();
    mock.reset();
  }
});

test("revert-fix: relay-A watermark does not suppress first-sync seed on relay-B", async () => {
  const relayA = "wss://a.relay.test";
  const relayB = "wss://b.relay.test";
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  fw.localStorage.setItem(
    `buzz-sync-watermark.v1:channel-mutes:pk-iso:${encodeURIComponent(relayA)}`,
    "1700000100",
  );
  const restore = installFakeWindow(fw);
  try {
    const managerB = new ChannelMuteSyncManager("pk-iso", relayB);
    const result = await managerB.bootstrap(makeStore({ ch1: E(true, 1, 0) }));
    assert.equal(result.action, "hold");
    assert.ok(
      managerB.getPendingMuteStore() !== null,
      "first-sync seed on relay B must not be blocked by relay A watermark",
    );
  } finally {
    restore();
    mock.reset();
  }
});
