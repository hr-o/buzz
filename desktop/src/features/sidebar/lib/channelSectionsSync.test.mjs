import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import { ChannelSectionSyncManager } from "./channelSectionsSync.ts";
import {
  makeFakeWindow,
  installFakeWindow,
  installTauriMock,
} from "./sidebarSyncTestHelpers.mjs";

function makeStore(overrides = {}) {
  return {
    version: 1,
    sections: overrides.sections ?? [],
    assignments: overrides.assignments ?? {},
    ...overrides,
  };
}

function makeSectionsStore(sections = []) {
  return { version: 1, sections, assignments: {} };
}

const RELAY = "wss://r.test";
const RELAY_KEY = encodeURIComponent(RELAY);

// ─── destroy() must cancel pending publish, not flush ─────────────────────────

// Regression guard for the community-switch cross-relay publish vector:
// edit sections in relay A → destroy() is called (relayUrl dep change) →
// no publish should fire.
test("destroy: cancels pending publish without flushing to the relay", () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  const publishCalls = [];
  mock.method(relayClient, "publishEvent", (...args) => {
    publishCalls.push(args);
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelSectionSyncManager("pk-test", RELAY);
    manager.publishSections(
      makeStore({ sections: [{ id: "s1", name: "Work", order: 0 }] }),
    );
    assert.ok(fw._hasTimer(), "debounce timer should be set");
    manager.destroy();
    assert.ok(!fw._hasTimer(), "debounce timer should be cleared on destroy");
    assert.equal(publishCalls.length, 0);
    assert.equal(manager.getPendingStore(), null);
  } finally {
    restore();
    mock.reset();
  }
});

// Regression guard for the timer-fired race: debounce fires → doPublish awaits
// fetchOwnBlobBeforePublish → destroy() called → publishEvent must not fire.
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
    const manager = new ChannelSectionSyncManager("pk-race", RELAY);
    manager.publishSections(
      makeStore({ sections: [{ id: "s1", name: "Work", order: 0 }] }),
    );
    fw._fireTimer(); // starts doPublish, which is now awaiting fetchOwnBlobBeforePublish
    manager.destroy();
    releaseFetch();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(
      publishCalls.length,
      0,
      "publishEvent must not fire after destroy",
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
    const manager = new ChannelSectionSyncManager("pk-no-pending", RELAY);
    assert.doesNotThrow(() => manager.destroy());
  } finally {
    restore();
  }
});

// ─── Boot seed-publish guard (the revert-fix regression suite) ────────────────
// Wiring tests 1-3 drive the production bootstrap() path; policy tested once
// in sidebarSyncWatermark.test.mjs.

// 1. fetch failed → hold, pendingStore null (mutation: remove failed guard → seed queued)
test("revert-fix: fetch failed (error) does not trigger seed-publish via bootstrap", async () => {
  mock.method(relayClient, "fetchEvents", () =>
    Promise.reject(new Error("relay timeout")),
  );
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelSectionSyncManager("pk-fail", RELAY);
    const result = await manager.bootstrap(
      makeSectionsStore([{ id: "s1", name: "Work", order: 0 }]),
    );
    assert.equal(result.action, "hold");
    assert.equal(manager.getPendingStore(), null);
  } finally {
    restore();
    mock.reset();
  }
});

// 2. absent + prior watermark → hold, pendingStore null (mutation: clear watermark → seed queued)
test("revert-fix: absent fetch with prior watermark blocks seed-publish via bootstrap", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  fw.localStorage.setItem(
    `buzz-sync-watermark.v1:channel-sections:pk-stale:${RELAY_KEY}`,
    "1700000000",
  );
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelSectionSyncManager("pk-stale", RELAY);
    assert.ok(
      Number(
        fw.localStorage.getItem(
          `buzz-sync-watermark.v1:channel-sections:pk-stale:${RELAY_KEY}`,
        ) ?? "0",
      ) > 0,
    );
    const result = await manager.bootstrap(
      makeSectionsStore([{ id: "s1", name: "Work", order: 0 }]),
    );
    assert.equal(result.action, "hold");
    assert.equal(manager.getPendingStore(), null);
  } finally {
    restore();
    mock.reset();
  }
});

// 3. absent + zero watermark + non-empty → seed queued (mutation: remove seed call → pendingStore null)
test("revert-fix: absent fetch with zero watermark seeds via bootstrap (first-sync preserved)", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", () => Promise.resolve());
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelSectionSyncManager("pk-fresh", RELAY);
    const result = await manager.bootstrap(
      makeSectionsStore([{ id: "s1", name: "Work", order: 0 }]),
    );
    assert.equal(result.action, "hold");
    assert.ok(manager.getPendingStore() !== null);
  } finally {
    restore();
    mock.reset();
  }
});

// 4. Adopt-winner: a newer remote head at pre-publish time supersedes the local
//    edit — the manager must NOT publish, must hand the remote to the adopt
//    sink, and must clear the pending/outbox so the loser can't be replayed.
// Mutation test: reverting adopt→republish makes onRemoteAdopted never fire and
// publishEvent fire instead.
test("adopt-winner: newer remote head at pre-publish adopts remote and skips publish", async () => {
  const REMOTE_ID = "remote-section-from-relay";
  mock.method(relayClient, "fetchEvents", () =>
    Promise.resolve([
      {
        pubkey: "pk-lww",
        content: "good-cipher",
        created_at: 200,
        id: "evt-remote",
      },
    ]),
  );
  const publishCalls = [];
  mock.method(relayClient, "publishEvent", (...args) => {
    publishCalls.push(args);
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  const tauri = installTauriMock(
    JSON.stringify({
      version: 1,
      sections: [{ id: REMOTE_ID, name: "Remote", order: 0 }],
      assignments: {},
    }),
  );
  try {
    const manager = new ChannelSectionSyncManager("pk-lww", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((r) => adopted.push(r));
    manager.publishSections(
      makeSectionsStore([{ id: "local-s", name: "Local", order: 0 }]),
    );
    // Outbox persisted synchronously on the edit.
    assert.ok(
      fw.localStorage.getItem(
        `buzz-channel-sections-outbox.v1:pk-lww:${RELAY_KEY}`,
      ) !== null,
      "edit must be persisted to the durable outbox",
    );
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      publishCalls.length,
      0,
      "must not publish when a newer remote head wins LWW",
    );
    assert.equal(adopted.length, 1, "adopt sink must receive the remote");
    assert.ok(
      adopted[0].store.sections.some((s) => s.id === REMOTE_ID),
      "adopted store must be the remote content",
    );
    assert.equal(manager.getPendingStore(), null, "pending must be cleared");
    assert.equal(
      fw.localStorage.getItem(
        `buzz-channel-sections-outbox.v1:pk-lww:${RELAY_KEY}`,
      ),
      null,
      "outbox must be cleared on adopt so the loser is never replayed",
    );
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// 4b. Local edit wins (no newer remote head): publishes and clears the outbox.
test("adopt-winner: local edit at/ahead of head publishes and clears outbox", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  const publishCalls = [];
  mock.method(relayClient, "publishEvent", (...args) => {
    publishCalls.push(args);
    return Promise.resolve();
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  const tauri = installTauriMock("{}");
  try {
    const manager = new ChannelSectionSyncManager("pk-win", RELAY);
    manager.publishSections(
      makeSectionsStore([{ id: "s1", name: "Work", order: 0 }]),
    );
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(publishCalls.length, 1, "local edit must be published");
    assert.equal(
      fw.localStorage.getItem(
        `buzz-channel-sections-outbox.v1:pk-win:${RELAY_KEY}`,
      ),
      null,
      "outbox must be cleared once the edit is published",
    );
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// 4c. Timestamp clamp: a remote head far in the future must not make the
//     published createdAt walk past the relay's ±15min window.
// Mutation test: removing the Math.min clamp lets createdAt = lastRemote+1
// (~now+3600), which exceeds now + MAX_PUBLISH_FUTURE_SECS.
test("timestamp clamp: published createdAt stays inside the relay future window", async () => {
  const nowSecs = Math.floor(Date.now() / 1000);
  const farFutureHead = nowSecs + 3_600; // 1h ahead — beyond the ±15min window
  let call = 0;
  mock.method(relayClient, "fetchEvents", () => {
    call++;
    // First call: fetchRemoteSections during a manual head prime; subsequent:
    // pre-publish fetch. Return the far-future undecryptable head each time so
    // lastRemoteCreatedAt is pushed to farFutureHead but the store still
    // publishes (local edit is what we're stamping).
    return Promise.resolve([
      {
        pubkey: "pk-clamp",
        content: "good-cipher",
        created_at: call === 1 ? farFutureHead : 0,
        id: "evt-clamp",
      },
    ]);
  });
  let signedCreatedAt = null;
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  const tauri = installTauriMock(
    JSON.stringify({ version: 1, sections: [], assignments: {} }),
  );
  mock.method(relayClient, "publishEvent", (evt) => {
    signedCreatedAt = evt.created_at;
    return Promise.resolve();
  });
  try {
    const manager = new ChannelSectionSyncManager("pk-clamp", RELAY);
    // Prime lastRemoteCreatedAt to the far-future head.
    await manager.fetchRemoteSections();
    manager.publishSections(
      makeSectionsStore([{ id: "s1", name: "Work", order: 0 }]),
    );
    // Fire debounce; pre-publish fetch returns created_at=0 so local wins.
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(signedCreatedAt !== null, "publish must have been attempted");
    assert.ok(
      signedCreatedAt <= Math.floor(Date.now() / 1000) + 840,
      `createdAt must be clamped inside the future window — got ${signedCreatedAt}`,
    );
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// 5. live-sub: undecryptable event on live path records head before decrypt
// Mutation test: removing recordRemoteHead before decrypt in the live callback
// leaves watermark at 0 after a live event.
test("revert-fix: undecryptable live event advances watermark before decrypt attempt", async () => {
  let liveCallback = null;
  mock.method(relayClient, "subscribeLive", (_filter, onEvent) => {
    liveCallback = onEvent;
    return Promise.resolve(async () => {});
  });
  const fw = makeFakeWindow();
  const restore = installFakeWindow(fw);
  try {
    const manager = new ChannelSectionSyncManager("pk-live", RELAY);
    assert.equal(
      fw.localStorage.getItem(
        `buzz-sync-watermark.v1:channel-sections:pk-live:${RELAY_KEY}`,
      ),
      null,
      "watermark starts absent",
    );
    await manager.subscribeToSections(() => {});
    assert.ok(
      liveCallback !== null,
      "subscribeLive must have captured the callback",
    );
    liveCallback({
      pubkey: "pk-live",
      content: "!bad-cipher!",
      created_at: 1700005555,
      id: "live-evt-1",
    });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(
      Number(
        fw.localStorage.getItem(
          `buzz-sync-watermark.v1:channel-sections:pk-live:${RELAY_KEY}`,
        ) ?? "0",
      ) >= 1700005555,
      "live undecryptable event must advance the watermark before decrypt is attempted",
    );
  } finally {
    restore();
    mock.reset();
  }
});

// 6. Overlapping publishes (fix 1): an older in-flight publish must not clear a
//    newer edit queued while it was in flight. Regression for the generation
//    compare-and-swap on discardPending — reverting the gen guard makes the
//    older completion null out B's pendingStore + outbox.
test("overlapping publishes: older completion does not erase a newer queued edit", async () => {
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  // First publish blocks until we release it; a second publish is queued while
  // the first is in flight.
  let releaseFirst = null;
  let publishCalls = 0;
  mock.method(relayClient, "publishEvent", () => {
    publishCalls++;
    if (publishCalls === 1) {
      return new Promise((res) => {
        releaseFirst = res;
      });
    }
    return Promise.resolve();
  });
  // A multi-slot timer fake: each setTimeout is retained by delay so we can fire
  // the debounce independently and inspect what remains.
  const storage = new Map();
  const timers = new Map();
  let nextId = 1;
  const fakeWindow = {
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
  const fireDelay = async (ms) => {
    const entry = [...timers.entries()].find(([, v]) => v.ms === ms);
    assert.ok(entry, `expected a timer scheduled at ${ms}ms`);
    timers.delete(entry[0]);
    entry[1].fn();
    await Promise.resolve();
    await Promise.resolve();
  };
  const restore = installFakeWindow(fakeWindow);
  const tauri = installTauriMock("{}");
  const outboxKey = `buzz-channel-sections-outbox.v1:pk-overlap:${RELAY_KEY}`;
  try {
    const manager = new ChannelSectionSyncManager("pk-overlap", RELAY);
    const storeA = makeSectionsStore([{ id: "a", name: "A", order: 0 }]);
    const storeB = makeSectionsStore([{ id: "b", name: "B", order: 0 }]);

    manager.publishSections(storeA);
    await fireDelay(2000); // debounce → doPublish(A) awaits publishEvent
    while (releaseFirst === null) await Promise.resolve();

    // Edit B arrives while A is still in flight.
    manager.publishSections(storeB);
    assert.deepEqual(
      manager.getPendingStore()?.sections.map((s) => s.id),
      ["b"],
      "B is now the pending edit",
    );
    assert.equal(
      JSON.parse(storage.get(outboxKey)).sections[0].id,
      "b",
      "outbox holds B",
    );

    // A completes — its success path must NOT clear B's pending/outbox.
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(
      manager.getPendingStore()?.sections.map((s) => s.id),
      ["b"],
      "older completion must leave B pending",
    );
    assert.ok(
      storage.get(outboxKey) !== undefined,
      "older completion must leave B's outbox intact",
    );
    assert.ok(
      [...timers.values()].some((t) => t.ms === 2000),
      "B's debounce timer must survive so it still publishes",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// 7. Live remote during debounce (pass-2 finding 1): a remote head accepted
//    while a local edit is debouncing must be adopted at pre-publish, not
//    overwritten. The live event advances the watermark before doPublish runs,
//    so comparing the fetched head against the mutable watermark would see
//    equality and publish over the newer remote. The pre-publish check compares
//    against the baseline frozen at publishSections instead. Mutation: comparing
//    against lastRemoteCreatedAt rather than publishBaseline republishes local.
test("live remote during debounce is adopted at pre-publish, not overwritten", async () => {
  const remoteEvent = {
    id: "remote-event",
    pubkey: "pk-livedebounce",
    content: "good-cipher",
    created_at: 1_700_000_100,
    kind: 30078,
    tags: [["d", "channel-sections"]],
    sig: "s",
  };
  // Pre-publish fetch returns the same live head that arrived during debounce.
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([remoteEvent]));
  const publishCalls = [];
  mock.method(relayClient, "publishEvent", (...args) => {
    publishCalls.push(args);
    return Promise.resolve();
  });
  let live = null;
  mock.method(relayClient, "subscribeLive", async (_filter, cb) => {
    live = cb;
    return async () => {};
  });

  const storage = new Map();
  const timers = new Map();
  let nextId = 1;
  const fakeWindow = {
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
  const fireDelay = async (ms) => {
    const entry = [...timers.entries()].find(([, v]) => v.ms === ms);
    assert.ok(entry, `expected a timer scheduled at ${ms}ms`);
    timers.delete(entry[0]);
    entry[1].fn();
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };
  const restore = installFakeWindow(fakeWindow);
  const tauri = installTauriMock(
    JSON.stringify({
      version: 1,
      sections: [{ id: "remote", name: "Remote", order: 0 }],
      assignments: {},
    }),
  );
  const outboxKey = `buzz-channel-sections-outbox.v1:pk-livedebounce:${RELAY_KEY}`;
  try {
    const manager = new ChannelSectionSyncManager("pk-livedebounce", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((remote) => adopted.push(remote.eventId));
    await manager.subscribeToSections(() => {});
    assert.ok(live, "live subscription installed");

    manager.publishSections(
      makeSectionsStore([{ id: "local", name: "Local", order: 0 }]),
    );
    // A genuinely later remote head is accepted and delivered while local is
    // pending — this advances the watermark past the frozen baseline.
    live(remoteEvent);
    for (let i = 0; i < 50; i++) await Promise.resolve();

    await fireDelay(2000);

    assert.equal(
      publishCalls.length,
      0,
      "later remote head must prevent the local publish",
    );
    assert.deepEqual(
      adopted,
      ["remote-event"],
      "the remote accepted after the edit began must be adopted",
    );
    assert.equal(manager.getPendingStore(), null, "pending cleared on adopt");
    assert.equal(
      storage.get(outboxKey),
      undefined,
      "outbox cleared on adopt so the loser can't replay",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// 8. Serialized generations (fix round 3, pass-3 finding 1): an older in-flight
//    publish that completes after a newer edit is queued must NOT be mistaken
//    for a remote that advanced past the newer edit's baseline. A blocks in
//    publishEvent; B is queued; A succeeds; B's pre-publish fetch returns A's
//    accepted head. Because the baseline is frozen at B's own cycle start —
//    after A's completion recorded its head — B publishes above A instead of
//    adopting it. Mutation: freezing the baseline at publishSections (before the
//    prior cycle completes) makes B see A as a post-baseline remote and adopt it.
test("serialized generations: older completion does not make the newer edit adopt it", async () => {
  let releaseFirst = null;
  let publishCalls = 0;
  let storedHead = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve(storedHead));
  mock.method(relayClient, "publishEvent", (event) => {
    publishCalls++;
    if (publishCalls === 1) {
      // A's publish blocks; when it resolves, its event becomes the stored head
      // the next pre-publish fetch will return.
      return new Promise((res) => {
        releaseFirst = () => {
          storedHead = [
            {
              id: "event-a",
              pubkey: "pk-serial",
              content: "good-cipher",
              created_at: event.created_at,
              kind: 30078,
              tags: [["d", "channel-sections"]],
              sig: "s",
            },
          ];
          res();
        };
      });
    }
    return Promise.resolve();
  });
  const storage = new Map();
  const timers = new Map();
  let nextId = 1;
  const fakeWindow = {
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
  const fireDelay = async (ms) => {
    const entry = [...timers.entries()].find(([, v]) => v.ms === ms);
    assert.ok(entry, `expected a timer scheduled at ${ms}ms`);
    timers.delete(entry[0]);
    entry[1].fn();
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  const restore = installFakeWindow(fakeWindow);
  // A's decrypted head must parse; the pre-publish check reads its created_at/id.
  const tauri = installTauriMock(
    JSON.stringify({
      version: 1,
      sections: [{ id: "a", name: "A", order: 0 }],
      assignments: {},
    }),
  );
  try {
    const manager = new ChannelSectionSyncManager("pk-serial", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((remote) => adopted.push(remote.eventId));

    manager.publishSections(
      makeSectionsStore([{ id: "a", name: "A", order: 0 }]),
    );
    await fireDelay(2000); // A's cycle → publishEvent(A) blocks
    while (releaseFirst === null) await Promise.resolve();

    // B is queued while A is still in flight; its cycle must defer.
    manager.publishSections(
      makeSectionsStore([{ id: "b", name: "B", order: 0 }]),
    );
    assert.deepEqual(
      manager.getPendingStore()?.sections.map((s) => s.id),
      ["b"],
      "B is the pending edit while A is in flight",
    );

    releaseFirst(); // A completes, recording its head; the freed lane drives B
    for (let i = 0; i < 100; i++) await Promise.resolve();
    // If B's cycle did not auto-drive on the freed lane, its debounce timer is
    // still pending — fire it.
    if ([...timers.values()].some((t) => t.ms === 2000)) await fireDelay(2000);

    assert.deepEqual(adopted, [], "B must not adopt the older generation A");
    assert.equal(
      publishCalls,
      2,
      "B publishes above A rather than adopting A's accepted head",
    );
    assert.equal(
      manager.getPendingStore(),
      null,
      "B's pending clears via its own successful publish, not A's completion",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// 9. Serialized generations (fix round 3, pass-3 finding 1): a stale generation
//    must never sign/publish after a newer edit is queued. A blocks in the
//    pre-publish fetch; B is queued during that await; A must abort before
//    signing. Mutation: dropping the post-fetch generation re-check in doPublish
//    lets the stale A continue to publishEvent.
test("serialized generations: a stale generation aborts before publishing", async () => {
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
  const storage = new Map();
  const timers = new Map();
  let nextId = 1;
  const fakeWindow = {
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
  const fireDelay = async (ms) => {
    const entry = [...timers.entries()].find(([, v]) => v.ms === ms);
    assert.ok(entry, `expected a timer scheduled at ${ms}ms`);
    timers.delete(entry[0]);
    entry[1].fn();
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  const restore = installFakeWindow(fakeWindow);
  const tauri = installTauriMock("{}");
  try {
    const manager = new ChannelSectionSyncManager("pk-stale", RELAY);
    manager.publishSections(
      makeSectionsStore([{ id: "a", name: "A", order: 0 }]),
    );
    await fireDelay(2000); // A's cycle → doPublish(A) awaits fetchEvents
    while (releaseFetch === null) await Promise.resolve();

    // B is queued while A is blocked in its pre-publish fetch.
    manager.publishSections(
      makeSectionsStore([{ id: "b", name: "B", order: 0 }]),
    );

    releaseFetch(); // A's fetch resolves; A must see gen moved and abort
    for (let i = 0; i < 100; i++) await Promise.resolve();

    assert.equal(
      publishCalls.length,
      0,
      "stale generation A must not sign/publish after B was queued",
    );
    assert.deepEqual(
      manager.getPendingStore()?.sections.map((s) => s.id),
      ["b"],
      "B remains the pending edit, owning convergence",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// Installs a Tauri mock whose sign_event returns a caller-controlled id per
// call (so overlapping publishes get distinct event ids) and whose
// nip44_encrypt_to_self can be made to block, exposing the encrypt/sign await
// window. `signIds` is consumed in order; the encrypt block is armed on demand.
function installSeamTauriMock(payload, signIds) {
  const orig = globalThis.window?.__TAURI_INTERNALS__;
  if (typeof globalThis.window === "undefined") globalThis.window = {};
  let signCall = 0;
  let releaseEncrypt = null;
  let blockNextEncrypt = false;
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === "nip44_decrypt_from_self") return Promise.resolve(payload);
      if (cmd === "nip44_encrypt_to_self") {
        if (!blockNextEncrypt) return Promise.resolve("ct");
        blockNextEncrypt = false;
        return new Promise((res) => {
          releaseEncrypt = () => res("ct");
        });
      }
      if (cmd === "sign_event") {
        const id = signIds[Math.min(signCall, signIds.length - 1)];
        signCall++;
        return Promise.resolve(
          JSON.stringify({
            id,
            pubkey: "pk",
            content: "ct",
            created_at: args?.createdAt ?? 0,
            kind: args?.kind ?? 0,
            tags: args?.tags ?? [],
            sig: "s",
          }),
        );
      }
      return Promise.reject(new Error(`unmocked: ${cmd}`));
    },
  };
  return {
    restore: () => {
      if (orig !== undefined) globalThis.window.__TAURI_INTERNALS__ = orig;
      else delete globalThis.window.__TAURI_INTERNALS__;
    },
    armEncryptBlock: () => {
      blockNextEncrypt = true;
    },
    releaseEncrypt: () => releaseEncrypt?.(),
    hasEncryptBlocked: () => releaseEncrypt !== null,
  };
}

// 10. Ambiguous ACK (fix round 4, pass-4 finding 1): the relay accepts A but the
//     client's ACK is lost (publish promise rejects as a timeout). B was queued
//     mid-flight. When B's pre-publish fetch returns A's accepted head, it must
//     recognise A as OUR OWN accepted predecessor — fold it forward and publish
//     above it — not adopt it and erase B. Mutation: dropping the
//     ambiguousAttemptIds fold makes B classify A as a foreign advance and adopt.
test("ambiguous ACK: an accepted-but-unacked A does not make B adopt and disappear", async () => {
  let releaseFirst = null;
  let publishCalls = 0;
  let storedHead = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve(storedHead));
  mock.method(relayClient, "publishEvent", (event) => {
    publishCalls++;
    if (publishCalls === 1) {
      // A reaches the relay and is stored, but the ACK never arrives: the
      // promise rejects as a timeout after the frame has left.
      return new Promise((_res, reject) => {
        releaseFirst = () => {
          storedHead = [
            {
              id: "event-a",
              pubkey: "pk-ambiguous",
              content: "good-cipher",
              created_at: event.created_at,
              kind: 30078,
              tags: [["d", "channel-sections"]],
              sig: "s",
            },
          ];
          reject(new Error("Timed out publishing channel sections."));
        };
      });
    }
    return Promise.resolve();
  });
  const storage = new Map();
  const timers = new Map();
  let nextId = 1;
  const fakeWindow = {
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
  const fireDelay = async (ms) => {
    const entry = [...timers.entries()].find(([, v]) => v.ms === ms);
    assert.ok(entry, `expected a timer scheduled at ${ms}ms`);
    timers.delete(entry[0]);
    entry[1].fn();
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  const restore = installFakeWindow(fakeWindow);
  const tauri = installSeamTauriMock(
    JSON.stringify({
      version: 1,
      sections: [{ id: "a", name: "A", order: 0 }],
      assignments: {},
    }),
    ["event-a", "event-b"],
  );
  try {
    const manager = new ChannelSectionSyncManager("pk-ambiguous", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((r) => adopted.push(r.eventId));

    manager.publishSections(
      makeSectionsStore([{ id: "a", name: "A", order: 0 }]),
    );
    await fireDelay(2000); // A's cycle → publishEvent(A) blocks
    while (releaseFirst === null) await Promise.resolve();

    manager.publishSections(
      makeSectionsStore([{ id: "b", name: "B", order: 0 }]),
    );

    releaseFirst(); // A's ACK is lost; A is stored on the relay regardless
    for (let i = 0; i < 100; i++) await Promise.resolve();
    if ([...timers.values()].some((t) => t.ms === 2000)) await fireDelay(2000);
    for (let i = 0; i < 100; i++) await Promise.resolve();

    assert.deepEqual(
      adopted,
      [],
      "B must not adopt A when A was accepted but its ACK was lost",
    );
    assert.equal(
      publishCalls,
      2,
      "B publishes above A's ambiguously-accepted head",
    );
    assert.equal(
      manager.getPendingStore(),
      null,
      "B's own successful publish clears its pending edit",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// 11. Ambiguous ACK, negative case (fix round 4, pass-4 finding 1): the fold is
//     gated on an exact id-match against a prior attempt. An advancing head
//     whose id is NOT one of our attempts is a genuine foreign winner and must
//     be ADOPTED, never folded. A's ACK is lost (transient) so its id stays in
//     the ambiguous set, but the head that surfaces is a DIFFERENT foreign id —
//     proof the relay never accepted A. B must adopt the foreign winner, not
//     fold it and publish above it. Mutation: dropping the ambiguousAttemptIds
//     id-guard (folding any advance) makes B erase the foreign winner.
test("ambiguous ACK: a foreign head is adopted, not folded as our own", async () => {
  let publishCalls = 0;
  let fetchCalls = 0;
  mock.method(relayClient, "fetchEvents", () => {
    fetchCalls++;
    // 1: A's pre-publish fetch (empty → A publishes, then its ACK times out).
    // 2+: B's pre-publish fetch surfaces a FOREIGN winner (id != A's attempt).
    if (fetchCalls === 1) return Promise.resolve([]);
    return Promise.resolve([
      {
        id: "foreign-winner",
        pubkey: "pk-reject",
        content: "good-cipher",
        created_at: 500,
        kind: 30078,
        tags: [["d", "channel-sections"]],
        sig: "s",
      },
    ]);
  });
  mock.method(relayClient, "publishEvent", () => {
    publishCalls++;
    // A's ACK is lost as a transient timeout; the relay never stored A.
    if (publishCalls === 1)
      return Promise.reject(
        new Error("Timed out publishing channel sections."),
      );
    return Promise.resolve();
  });
  const storage = new Map();
  const timers = new Map();
  let nextId = 1;
  const fakeWindow = {
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
  const fireDelay = async (ms) => {
    const entry = [...timers.entries()].find(([, v]) => v.ms === ms);
    assert.ok(entry, `expected a timer scheduled at ${ms}ms`);
    timers.delete(entry[0]);
    entry[1].fn();
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  const restore = installFakeWindow(fakeWindow);
  const tauri = installSeamTauriMock(
    JSON.stringify({
      version: 1,
      sections: [{ id: "a", name: "A", order: 0 }],
      assignments: {},
    }),
    ["event-a", "event-b"],
  );
  try {
    const manager = new ChannelSectionSyncManager("pk-reject", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((r) => adopted.push(r.eventId));

    manager.publishSections(
      makeSectionsStore([{ id: "a", name: "A", order: 0 }]),
    );
    await fireDelay(2000); // A's cycle → publishEvent rejects (ACK lost)
    for (let i = 0; i < 100; i++) await Promise.resolve();

    // B is queued; it supersedes A's scheduled retry.
    manager.publishSections(
      makeSectionsStore([{ id: "b", name: "B", order: 0 }]),
    );
    if ([...timers.values()].some((t) => t.ms === 2000)) await fireDelay(2000);
    for (let i = 0; i < 100; i++) await Promise.resolve();

    assert.deepEqual(
      adopted,
      ["foreign-winner"],
      "B adopts the foreign head; its id is not one of our attempts",
    );
    assert.equal(
      manager.getPendingStore(),
      null,
      "adopt clears the pending edit",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});

// 12. Pre-sign generation guard seam (fix round 4, pass-4 review): the guard
//     immediately before signing/publishing (post-encrypt) must be individually
//     load-bearing. B arrives DURING A's encrypt/sign await — past the
//     post-fetch guard — so only the pre-sign guard can stop A publishing a
//     stale store. Mutation: dropping the gen re-check at the pre-sign guard
//     lets stale A reach publishEvent after B was queued.
test("serialized generations: a newer edit during encrypt/sign aborts the pre-sign publish", async () => {
  const publishCalls = [];
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "publishEvent", (event) => {
    publishCalls.push(event);
    return Promise.resolve();
  });
  const storage = new Map();
  const timers = new Map();
  let nextId = 1;
  const fakeWindow = {
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
  const fireDelay = async (ms) => {
    const entry = [...timers.entries()].find(([, v]) => v.ms === ms);
    assert.ok(entry, `expected a timer scheduled at ${ms}ms`);
    timers.delete(entry[0]);
    entry[1].fn();
    for (let i = 0; i < 100; i++) await Promise.resolve();
  };
  const restore = installFakeWindow(fakeWindow);
  const tauri = installSeamTauriMock("{}", ["event-a", "event-b"]);
  try {
    const manager = new ChannelSectionSyncManager("pk-seam", RELAY);
    tauri.armEncryptBlock(); // A's encrypt will block, exposing the sign window
    manager.publishSections(
      makeSectionsStore([{ id: "a", name: "A", order: 0 }]),
    );
    await fireDelay(2000); // A's cycle → passes post-fetch guard, blocks in encrypt
    while (!tauri.hasEncryptBlocked()) await Promise.resolve();

    // B is queued while A is mid encrypt/sign — after A's post-fetch guard.
    manager.publishSections(
      makeSectionsStore([{ id: "b", name: "B", order: 0 }]),
    );

    tauri.releaseEncrypt(); // A resumes; the pre-sign guard must abort it
    for (let i = 0; i < 100; i++) await Promise.resolve();
    if ([...timers.values()].some((t) => t.ms === 2000)) await fireDelay(2000);
    for (let i = 0; i < 100; i++) await Promise.resolve();

    assert.equal(
      publishCalls.length,
      1,
      "only B publishes; stale A aborts at the pre-sign guard",
    );
    assert.equal(
      publishCalls[0].id,
      "event-b",
      "the surviving publish is B, not the stale A",
    );
    manager.destroy();
  } finally {
    tauri.restore();
    restore();
    mock.reset();
  }
});
