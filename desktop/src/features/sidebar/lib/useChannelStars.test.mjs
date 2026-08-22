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

test("same-second star and unstar mutations survive at capacity", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { MAX_CHANNEL_STAR_ENTRIES, readChannelStarsStore, storageKey } =
    await import("./channelStarsStorage.ts");
  const { useChannelStars } = await import("./useChannelStars.ts");

  const originalFetchEvents = relayClient.fetchEvents;
  const originalSubscribeLive = relayClient.subscribeLive;
  const originalSubscribeToReconnects = relayClient.subscribeToReconnects;
  const originalDateNow = Date.now;
  const updatedAt = 1_234_567;
  Date.now = () => updatedAt * 1_000;
  relayClient.fetchEvents = async () => [];
  relayClient.subscribeLive = async () => async () => {};
  relayClient.subscribeToReconnects = () => () => {};

  const relayUrl = "wss://relay.example";
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_STAR_ENTRIES }, (_, index) => [
      `z-channel-${String(index).padStart(3, "0")}`,
      { starred: true, updatedAt },
    ]),
  );

  try {
    for (const [pubkey, action, expectedStarred] of [
      ["pk-star", "starChannel", true],
      ["pk-unstar", "unstarChannel", false],
    ]) {
      window.localStorage.setItem(
        storageKey(pubkey),
        JSON.stringify({ version: 1, channels }),
      );
      const { result, unmount } = renderHook(() =>
        useChannelStars(pubkey, relayUrl),
      );

      act(() => result.current[action]("a-target"));

      const persisted = readChannelStarsStore(pubkey);
      assert.equal(
        Object.keys(persisted.channels).length,
        MAX_CHANNEL_STAR_ENTRIES,
      );
      assert.deepEqual(persisted.channels["a-target"], {
        starred: expectedStarred,
        updatedAt,
      });
      unmount();
    }
  } finally {
    cleanup();
    Date.now = originalDateNow;
    relayClient.fetchEvents = originalFetchEvents;
    relayClient.subscribeLive = originalSubscribeLive;
    relayClient.subscribeToReconnects = originalSubscribeToReconnects;
  }
});

// Equal-timestamp tie-break must match the relay's canonical winner
// (`created_at DESC, id ASC` → LOWEST id wins). Deliver the larger id first,
// then the lower id at the same timestamp; the lower id is the stored winner
// and must be applied, not rejected. Reverting applyRemote's `>=` back to `<=`
// wrongly ignores the lower id (the actual relay winner).
test("equal-timestamp tie-break applies the lower event id (relay canonical winner)", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelStars } = await import("./useChannelStars.ts");

  const origFetch = relayClient.fetchEvents;
  const origLive = relayClient.subscribeLive;
  const origReconnect = relayClient.subscribeToReconnects;
  const origTauri = window.__TAURI_INTERNALS__;

  let live = null;
  relayClient.fetchEvents = async () => [];
  relayClient.subscribeLive = async (_f, cb) => {
    live = cb;
    return async () => {};
  };
  relayClient.subscribeToReconnects = () => () => {};
  // Decrypt payload keyed off the event id embedded in the ciphertext so each
  // delivered event yields a store starring a distinct channel we can assert on.
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === "nip44_decrypt_from_self") {
        const id = args?.ciphertext ?? "";
        return Promise.resolve(
          JSON.stringify({
            version: 1,
            channels: { [id]: { starred: true, updatedAt: 0 } },
          }),
        );
      }
      return Promise.reject(new Error(`unmocked ${cmd}`));
    },
  };

  const pubkey = "pk-star-tie";
  const relayUrl = "wss://r.tie";
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelStars(pubkey, relayUrl));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(live, "live subscription installed");

    const deliver = async (id) => {
      await act(async () => {
        live({
          id,
          pubkey,
          created_at: 1000,
          content: id, // decrypt echoes this into the starred channel id
          kind: 30078,
          tags: [["d", "channel-stars"]],
          sig: "s",
        });
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    // Larger id first (applied), then the lower id at the same timestamp — the
    // relay's canonical winner, which must NOT be rejected.
    await deliver("bbbb");
    await deliver("aaaa");

    assert.ok(
      hook.result.current.starredChannelIds.has("aaaa"),
      "lower event id (relay canonical winner) must be applied, not rejected",
    );
    hook.unmount();
  } finally {
    cleanup();
    relayClient.fetchEvents = origFetch;
    relayClient.subscribeLive = origLive;
    relayClient.subscribeToReconnects = origReconnect;
    window.__TAURI_INTERNALS__ = origTauri;
  }
});

// Pass-2 finding 2: the comparator admitting the canonical lower id is
// necessary but not sufficient. Stars are a per-entry store, so applyRemote
// merges the incoming blob into local state. On the SAME channel, a stale
// larger-id event delivered first (starred=true) must not survive the merge
// once the canonical lower-id winner (starred=false) arrives at the same entry
// `updatedAt`. Mutation: reverting the apply path to mergeStores (local/prev
// wins on tie) keeps the stale starred=true value.
test("canonical lower-id unstar replaces a stale larger-id star at equal entry timestamp", async () => {
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { useChannelStars } = await import("./useChannelStars.ts");

  const origFetch = relayClient.fetchEvents;
  const origLive = relayClient.subscribeLive;
  const origReconnect = relayClient.subscribeToReconnects;
  const origTauri = window.__TAURI_INTERNALS__;

  let live = null;
  relayClient.fetchEvents = async () => [];
  relayClient.subscribeLive = async (_f, cb) => {
    live = cb;
    return async () => {};
  };
  relayClient.subscribeToReconnects = () => () => {};
  // Both events target the SAME channel `shared` at the same entry updatedAt.
  // The larger id `bbbb` says starred; the canonical lower id `aaaa` says not.
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === "nip44_decrypt_from_self") {
        const canonicalLowerId = args?.ciphertext === "aaaa";
        return Promise.resolve(
          JSON.stringify({
            version: 1,
            channels: {
              shared: { starred: !canonicalLowerId, updatedAt: 100 },
            },
          }),
        );
      }
      return Promise.reject(new Error(`unmocked ${cmd}`));
    },
  };

  const pubkey = "pk-star-shared-tie";
  const relayUrl = "wss://r.tie";
  let hook = null;
  try {
    await act(async () => {
      hook = renderHook(() => useChannelStars(pubkey, relayUrl));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(live, "live subscription installed");

    const deliver = async (id) => {
      await act(async () => {
        live({
          id,
          pubkey,
          created_at: 1000,
          content: id,
          kind: 30078,
          tags: [["d", "channel-stars"]],
          sig: "s",
        });
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
    };

    await deliver("bbbb"); // stale larger-id head says starred
    await deliver("aaaa"); // canonical lower-id winner says unstarred

    assert.equal(
      hook.result.current.starredChannelIds.has("shared"),
      false,
      "canonical lower-id unstar must replace the stale larger-id star",
    );
    hook.unmount();
  } finally {
    cleanup();
    relayClient.fetchEvents = origFetch;
    relayClient.subscribeLive = origLive;
    relayClient.subscribeToReconnects = origReconnect;
    window.__TAURI_INTERNALS__ = origTauri;
  }
});
