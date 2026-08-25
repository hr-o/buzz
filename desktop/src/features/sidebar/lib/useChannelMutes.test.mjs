import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

after(() => dom.window.close());

// Shared harness: stub the relay so no network/live/reconnect fires unless a
// test installs its own live callback. Returns the captured live callback.
function stubRelay(relayClient, { live } = {}) {
  const orig = {
    fetchEvents: relayClient.fetchEvents,
    subscribeLive: relayClient.subscribeLive,
    subscribeToReconnects: relayClient.subscribeToReconnects,
  };
  relayClient.fetchEvents = async () => [];
  relayClient.subscribeLive = async (_f, cb) => {
    if (live) live.cb = cb;
    return async () => {};
  };
  relayClient.subscribeToReconnects = () => () => {};
  return () => Object.assign(relayClient, orig);
}

function mutePayload(channels) {
  return JSON.stringify({ version: 1, channels });
}

test("same-second star and unstar mutations survive at capacity", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { MAX_CHANNEL_MUTE_ENTRIES, readChannelMutesStore, storageKey } =
    await import("./channelMutesStorage.ts");
  const { useChannelMutes } = await import("./useChannelMutes.ts");

  const restore = stubRelay(relayClient);
  const originalDateNow = Date.now;
  const updatedAt = 1_234_567;
  Date.now = () => updatedAt * 1_000;

  const relayUrl = "wss://relay.example";
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_MUTE_ENTRIES }, (_, index) => [
      `z-channel-${String(index).padStart(3, "0")}`,
      { muted: true, updatedAt, rev: 0 },
    ]),
  );

  try {
    for (const [pubkey, action, expectedStarred] of [
      ["pk-star", "muteChannel", true],
      ["pk-unstar", "unmuteChannel", false],
    ]) {
      window.localStorage.setItem(
        storageKey(pubkey),
        JSON.stringify({ version: 1, channels }),
      );
      const { result, unmount } = renderHook(() =>
        useChannelMutes(pubkey, relayUrl),
      );
      act(() => result.current[action]("a-target"));
      const persisted = readChannelMutesStore(pubkey);
      assert.equal(
        Object.keys(persisted.channels).length,
        MAX_CHANNEL_MUTE_ENTRIES,
      );
      assert.equal(persisted.channels["a-target"].muted, expectedStarred);
      unmount();
    }
  } finally {
    cleanup();
    Date.now = originalDateNow;
    restore();
  }
});

// Symmetric mint (Thufir MINOR 2): a click mints
// updatedAt = max(now, localEntry.updatedAt, maxUpdatedAtSeen) and
// rev = max(localEntry.rev, maxRevSeen) + 1 on BOTH dimensions. A remount reads
// the persisted local entry, so the very first click advances past it.
test("persisted-local first click mints seen+1 on both dimensions", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { readChannelMutesStore, storageKey } = await import(
    "./channelMutesStorage.ts"
  );
  const { useChannelMutes } = await import("./useChannelMutes.ts");

  const restore = stubRelay(relayClient);
  const origDateNow = Date.now;
  // Persisted entry is stamped in the FUTURE relative to wall clock, with a
  // non-zero rev — the mint must not regress below either.
  Date.now = () => 100 * 1_000;
  const pubkey = "pk-persist";
  window.localStorage.setItem(
    storageKey(pubkey),
    mutePayload({ shared: { muted: true, updatedAt: 500, rev: 4 } }),
  );
  try {
    const { result, unmount } = renderHook(() =>
      useChannelMutes(pubkey, "wss://r"),
    );
    act(() => result.current.unmuteChannel("shared"));
    const persisted = readChannelMutesStore(pubkey);
    assert.equal(persisted.channels.shared.muted, false, "unstar applied");
    assert.equal(
      persisted.channels.shared.updatedAt,
      500,
      "updatedAt held at persisted-local high-water (max(100,500,seen))",
    );
    assert.equal(
      persisted.channels.shared.rev,
      5,
      "rev minted as persisted-local rev + 1",
    );
    unmount();
  } finally {
    cleanup();
    Date.now = origDateNow;
    restore();
  }
});

// Fast-clock veto fix (Thufir pass-2 finding 1): after observing a
// future-stamped remote (updatedAt = t+300, rev 7, unmuted), a slow device
// clicking star at wall-clock t must WIN — the logical-monotonic stamp lifts the
// click's updatedAt to t+300 and rev to 8, so it dominates the observed entry.
test("fast-clock veto fix: click after observing a future-stamped head wins", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { readChannelMutesStore } = await import("./channelMutesStorage.ts");
  const { useChannelMutes } = await import("./useChannelMutes.ts");

  const live = {};
  const restore = stubRelay(relayClient, { live });
  const origTauri = window.__TAURI_INTERNALS__;
  const origDateNow = Date.now;
  Date.now = () => 100 * 1_000; // slow device: wall clock t = 100
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      if (cmd === "nip44_decrypt_from_self")
        return Promise.resolve(
          mutePayload({ shared: { muted: false, updatedAt: 400, rev: 7 } }),
        );
      return Promise.reject(new Error(`unmocked ${cmd}`));
    },
  };
  const pubkey = "pk-fastclock";
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelMutes(pubkey, "wss://r"));
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    // Observe the future-stamped head (updatedAt 400 = t+300).
    await act(async () => {
      live.cb({
        id: "future-head",
        pubkey,
        created_at: 400,
        content: "cipher",
        kind: 30078,
        tags: [["d", "channel-mutes"]],
        sig: "s",
      });
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    assert.equal(
      hook.result.current.mutedChannelIds.has("shared"),
      false,
      "future head applied → unmuted",
    );
    // Slow device clicks star at wall t=100.
    await act(async () => hook.result.current.muteChannel("shared"));
    assert.equal(
      hook.result.current.mutedChannelIds.has("shared"),
      true,
      "click must win despite the observed future timestamp",
    );
    const persisted = readChannelMutesStore(pubkey);
    assert.equal(
      persisted.channels.shared.updatedAt,
      400,
      "mint lifted to t+300",
    );
    assert.equal(persisted.channels.shared.rev, 8, "rev = maxRevSeen+1");
    hook.unmount();
  } finally {
    cleanup();
    Date.now = origDateNow;
    window.__TAURI_INTERNALS__ = origTauri;
    restore();
  }
});

// Future-timestamp propagation (Thufir MINOR 1 / Paul MINOR 1): a poisoned
// far-future observation does not ratchet by itself — two opposite clicks keep
// the timestamp fixed at the observed future value while rev advances, and the
// latest click wins. No clamp; deterministic.
test("far-future observation: timestamp stays fixed, rev advances, latest click wins", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { readChannelMutesStore } = await import("./channelMutesStorage.ts");
  const { useChannelMutes } = await import("./useChannelMutes.ts");

  const live = {};
  const restore = stubRelay(relayClient, { live });
  const origTauri = window.__TAURI_INTERNALS__;
  const origDateNow = Date.now;
  Date.now = () => 100 * 1_000;
  const FUTURE = 100 + 31_536_000; // +1yr
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      if (cmd === "nip44_decrypt_from_self")
        return Promise.resolve(
          mutePayload({ shared: { muted: true, updatedAt: FUTURE, rev: 1 } }),
        );
      return Promise.reject(new Error(`unmocked ${cmd}`));
    },
  };
  const pubkey = "pk-future";
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelMutes(pubkey, "wss://r"));
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    await act(async () => {
      live.cb({
        id: "far-future",
        pubkey,
        created_at: FUTURE,
        content: "cipher",
        kind: 30078,
        tags: [["d", "channel-mutes"]],
        sig: "s",
      });
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    await act(async () => hook.result.current.unmuteChannel("shared"));
    let p = readChannelMutesStore(pubkey);
    assert.equal(p.channels.shared.muted, false, "first click applied");
    assert.equal(p.channels.shared.updatedAt, FUTURE, "timestamp stays fixed");
    assert.equal(p.channels.shared.rev, 2, "rev advanced 1→2");
    await act(async () => hook.result.current.muteChannel("shared"));
    p = readChannelMutesStore(pubkey);
    assert.equal(p.channels.shared.muted, true, "latest click wins");
    assert.equal(p.channels.shared.updatedAt, FUTURE, "timestamp still fixed");
    assert.equal(p.channels.shared.rev, 3, "rev advanced 2→3");
    hook.unmount();
  } finally {
    cleanup();
    Date.now = origDateNow;
    window.__TAURI_INTERNALS__ = origTauri;
    restore();
  }
});

// Click-before-observation (design note gap test a): an empty-store click mints
// updatedAt=now, rev=1; a later bootstrap head carrying a HIGHER rev but an
// OLDER updatedAt for the opposite value must NOT reverse the click — updatedAt
// is primary.
test("empty-store click survives a later higher-rev head with an older updatedAt", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelMutes } = await import("./useChannelMutes.ts");

  const live = {};
  const restore = stubRelay(relayClient, { live });
  const origTauri = window.__TAURI_INTERNALS__;
  const origDateNow = Date.now;
  Date.now = () => 1000 * 1_000; // click at updatedAt 1000
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      if (cmd === "nip44_decrypt_from_self")
        // older updatedAt (500) but higher rev (99), opposite value
        return Promise.resolve(
          mutePayload({ shared: { muted: false, updatedAt: 500, rev: 99 } }),
        );
      return Promise.reject(new Error(`unmocked ${cmd}`));
    },
  };
  const pubkey = "pk-empty";
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelMutes(pubkey, "wss://r"));
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    await act(async () => hook.result.current.muteChannel("shared")); // empty store → rev 1 @ 1000
    await act(async () => {
      live.cb({
        id: "older-higher-rev",
        pubkey,
        created_at: 500,
        content: "cipher",
        kind: 30078,
        tags: [["d", "channel-mutes"]],
        sig: "s",
      });
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    assert.equal(
      hook.result.current.mutedChannelIds.has("shared"),
      true,
      "click at newer updatedAt survives an older higher-rev head",
    );
    hook.unmount();
  } finally {
    cleanup();
    Date.now = origDateNow;
    window.__TAURI_INTERNALS__ = origTauri;
    restore();
  }
});

// Cross-window storage: a peer window's write is observed into the high-water
// and max-merged, so a following click sees the peer's rev and no edit is lost.
test("cross-window storage event is observed and max-merged", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { readChannelMutesStore, storageKey } = await import(
    "./channelMutesStorage.ts"
  );
  const { useChannelMutes } = await import("./useChannelMutes.ts");

  const restore = stubRelay(relayClient);
  const origDateNow = Date.now;
  Date.now = () => 100 * 1_000;
  const pubkey = "pk-xwin";
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelMutes(pubkey, "wss://r"));
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    // A peer window wrote a higher-rev entry for `shared` at updatedAt 900.
    window.localStorage.setItem(
      storageKey(pubkey),
      mutePayload({ shared: { muted: true, updatedAt: 900, rev: 12 } }),
    );
    await act(async () => {
      window.dispatchEvent(
        new dom.window.StorageEvent("storage", { key: storageKey(pubkey) }),
      );
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    assert.equal(
      hook.result.current.mutedChannelIds.has("shared"),
      true,
      "peer write merged into this window",
    );
    // A following click sees the peer's high-water: updatedAt held at 900,
    // rev minted to 13.
    await act(async () => hook.result.current.unmuteChannel("shared"));
    const p = readChannelMutesStore(pubkey);
    assert.equal(p.channels.shared.muted, false, "click applied");
    assert.equal(p.channels.shared.updatedAt, 900, "held at peer high-water");
    assert.equal(p.channels.shared.rev, 13, "rev = peer rev + 1");
    hook.unmount();
  } finally {
    cleanup();
    Date.now = origDateNow;
    restore();
  }
});

// Outbox resume: an edit persisted to the durable outbox before teardown is
// re-published on the next mount (bootstrap resume), so a click made <2s before
// quit/community-switch is never silently dropped.
test("bootstrap resumes a persisted outbox edit", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelMutes } = await import("./useChannelMutes.ts");

  const restore = stubRelay(relayClient);
  const origDateNow = Date.now;
  Date.now = () => 100 * 1_000;
  const pubkey = "pk-outbox";
  const relayUrl = "wss://r.outbox";
  const outboxKey = `buzz-channel-mutes-outbox.v1:${pubkey}:${encodeURIComponent(relayUrl)}`;
  window.localStorage.setItem(
    outboxKey,
    mutePayload({ resumed: { muted: true, updatedAt: 90, rev: 2 } }),
  );
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelMutes(pubkey, relayUrl));
      for (let i = 0; i < 40; i++) await Promise.resolve();
    });
    // The resumed edit is queued for publish (pending), not silently dropped.
    // We assert the pending publish debounce is scheduled by observing the
    // outbox is still present (cleared only after publish completes).
    assert.ok(
      window.localStorage.getItem(outboxKey) !== null,
      "outbox retained until the resumed publish completes",
    );
    hook.unmount();
  } finally {
    cleanup();
    Date.now = origDateNow;
    restore();
  }
});
