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

// 4d. Conflict rejection: relay OK false → refetch head and adopt it.
test("conflict rejection: OK-false conflict refetches head and adopts remote", async () => {
  const REMOTE_ID = "remote-after-conflict";
  let fetchCall = 0;
  mock.method(relayClient, "fetchEvents", () => {
    fetchCall++;
    // First fetch (pre-publish): empty → local wins and we publish.
    if (fetchCall === 1) return Promise.resolve([]);
    // Second fetch (post-conflict refetch): the winning remote head.
    return Promise.resolve([
      {
        pubkey: "pk-conflict",
        content: "good-cipher",
        created_at: 500,
        id: "evt-winner",
      },
    ]);
  });
  mock.method(relayClient, "publishEvent", () =>
    Promise.reject(new Error("conflict: newer version exists")),
  );
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
    const manager = new ChannelSectionSyncManager("pk-conflict", RELAY);
    const adopted = [];
    manager.setOnRemoteAdopted((r) => adopted.push(r));
    manager.publishSections(
      makeSectionsStore([{ id: "local-s", name: "Local", order: 0 }]),
    );
    fw._fireTimer();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(adopted.length, 1, "conflict must trigger adopt of the head");
    assert.ok(
      adopted[0].store.sections.some((s) => s.id === REMOTE_ID),
      "adopted store must be the winning remote content",
    );
    assert.equal(manager.getPendingStore(), null, "pending cleared on adopt");
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
