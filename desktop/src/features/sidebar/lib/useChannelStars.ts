import * as React from "react";

import { relayClient } from "@/shared/api/relayClient";
import {
  boundStarStore,
  clearChannelStarsOutbox,
  DEFAULT_STORE,
  mergeStores,
  readChannelStarsOutbox,
  readChannelStarsStore,
  starredChannelIdsFromStore,
  storageKey,
  writeChannelStarsStore,
  type ChannelStarEntry,
  type ChannelStarStore,
} from "./channelStarsStorage";
import { ChannelStarSyncManager } from "./channelStarsSync";
import type { RemoteStars } from "./channelStarsSync";

// Reconciliation cadence. Steady interval re-fetches the head on a healthy
// socket so a silently-lost publish converges without waiting for a reconnect
// that may never fire; the retry window backs off while the fetch keeps failing.
const RECONCILE_STEADY_MS = 60_000;
const RECONCILE_RETRY_BASE_MS = 3_000;
const RECONCILE_RETRY_MAX_MS = 60_000;

export function useChannelStars(
  pubkey: string | undefined,
  relayUrl?: string,
): {
  starredChannelIds: Set<string>;
  starChannel: (channelId: string) => void;
  unstarChannel: (channelId: string) => void;
} {
  const [store, setStore] = React.useState<ChannelStarStore>(() => {
    if (!pubkey) {
      return DEFAULT_STORE;
    }
    return readChannelStarsStore(pubkey);
  });

  const managerRef = React.useRef<ChannelStarSyncManager | null>(null);

  React.useEffect(() => {
    if (!pubkey || !relayUrl) {
      setStore(DEFAULT_STORE);
      return;
    }
    setStore(readChannelStarsStore(pubkey));
    managerRef.current = new ChannelStarSyncManager(pubkey, relayUrl);
    return () => {
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, [pubkey, relayUrl]);

  // Cross-window sync: another window/tab wrote the shared store. Ingest it into
  // the high-water and max-merge it into this window's state, so a click that
  // follows sees the peer's revs/timestamps and no window's edit is clobbered.
  React.useEffect(() => {
    if (!pubkey) {
      return;
    }
    const key = storageKey(pubkey);
    const handler = (e: StorageEvent) => {
      if (e.key !== key) {
        return;
      }
      const incoming = readChannelStarsStore(pubkey);
      managerRef.current?.observe(incoming);
      setStore((prev) => mergeStores(prev, incoming));
    };
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("storage", handler);
    };
  }, [pubkey]);

  // Every remote payload is observed by the manager before it reaches here
  // (fetch/subscribe paths call observe() internally; the storage handler
  // observes above), so this is a pure max-merge with no ordering or ownership
  // overlay — "later" lives in the (updatedAt, rev) tuple.
  const applyRemote = React.useCallback(
    (remote: RemoteStars): ((prev: ChannelStarStore) => ChannelStarStore) => {
      return (prev) => {
        if (!pubkey) return prev;
        const merged = mergeStores(prev, remote.store);
        if (!writeChannelStarsStore(pubkey, merged)) return prev;
        return merged;
      };
    },
    [pubkey],
  );

  React.useEffect(() => {
    if (!pubkey || !relayUrl) return;
    let cancelled = false;
    const local = readChannelStarsStore(pubkey);
    void managerRef.current?.bootstrap(local).then((result) => {
      if (cancelled) return;
      if (result.action === "apply-remote") {
        setStore(applyRemote(result.data));
      }
      // "hold": seed already performed by bootstrap (if first-sync), or blocked.
      // Resume any edit persisted to the durable outbox before a prior
      // quit/community-switch so a click made <2s before teardown still syncs.
      const outbox = readChannelStarsOutbox(pubkey, relayUrl);
      if (outbox) {
        managerRef.current?.publishStars(outbox);
      } else {
        clearChannelStarsOutbox(pubkey, relayUrl);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey, relayUrl, applyRemote]);

  // Reconciliation loop: a single scheduler that both retries a failed bootstrap
  // fetch with bounded backoff and periodically re-fetches the head, so a
  // silently-lost publish converges within the steady cadence without waiting
  // for a reconnect a healthy socket never fires. Also refreshes on visibility.
  React.useEffect(() => {
    if (!pubkey || !relayUrl) return;
    let cancelled = false;
    let timer: number | null = null;
    let delayMs = RECONCILE_RETRY_BASE_MS;

    const schedule = (ms: number) => {
      if (cancelled) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(tick, ms);
    };

    const tick = () => {
      void managerRef.current?.fetchRemoteStars().then((result) => {
        if (cancelled) return;
        if (result.status === "found") {
          // max-merge folds the head into state without dropping a pending
          // edit (that edit is in prev and owned by the manager's retry lane).
          setStore(applyRemote(result.data));
          delayMs = RECONCILE_STEADY_MS; // relay answered → steady cadence
        } else if (result.status === "absent") {
          delayMs = RECONCILE_STEADY_MS; // answered (no blob) → steady cadence
        } else {
          delayMs = Math.min(delayMs * 2, RECONCILE_RETRY_MAX_MS); // failed → back off
        }
        schedule(delayMs);
      });
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        delayMs = RECONCILE_RETRY_BASE_MS;
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    schedule(delayMs);

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pubkey, relayUrl, applyRemote]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: relayUrl is intentional — rebinds subscription when the active relay changes even though it is not used inside the effect body directly (the manager via managerRef.current carries it)
  React.useEffect(() => {
    if (!pubkey) return;
    let unsub: (() => Promise<void>) | null = null;
    let cancelled = false;
    void managerRef.current
      ?.subscribeToStars((remote) => {
        if (cancelled) return;
        setStore(applyRemote(remote));
      })
      .then((dispose) => {
        if (cancelled) {
          void dispose();
        } else {
          unsub = dispose;
        }
      });
    return () => {
      cancelled = true;
      if (unsub) void unsub();
    };
  }, [pubkey, relayUrl, applyRemote]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: relayUrl is intentional — rebinds reconnect listener when the active relay changes (community switch) even though it is not referenced directly inside the effect body
  React.useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    const unsub = relayClient.subscribeToReconnects(() => {
      void managerRef.current?.fetchRemoteStars().then((result) => {
        if (cancelled) return;
        if (result.status === "found") {
          setStore(applyRemote(result.data));
        }
        const pending = managerRef.current?.getPendingStarStore();
        if (pending) {
          managerRef.current?.publishStars(pending);
        }
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [pubkey, relayUrl, applyRemote]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: store.channels is the relevant dep — the outer store identity can change without channels changing (e.g., on reconnect writes)
  const starredChannelIds = React.useMemo(
    () => starredChannelIdsFromStore(store),
    [store.channels],
  );

  const setStarState = React.useCallback(
    (channelId: string, starred: boolean) => {
      if (!pubkey) return;
      const now = Math.floor(Date.now() / 1000);
      setStore((prev) => {
        const manager = managerRef.current;
        const localEntry = prev.channels[channelId];
        // Logical-monotonic mint: never regress below any (updatedAt, rev) this
        // replica has observed for the channel (local entry OR manager
        // high-water), so the click strictly dominates observed state in both
        // merge keys — it can never lose to state it has already seen.
        const updatedAt = Math.max(
          now,
          localEntry?.updatedAt ?? 0,
          manager?.maxUpdatedAtSeen(channelId) ?? 0,
        );
        const rev =
          Math.max(localEntry?.rev ?? 0, manager?.maxRevSeen(channelId) ?? 0) +
          1;
        const entry: ChannelStarEntry = { starred, updatedAt, rev };
        const next = boundStarStore(
          {
            version: 1,
            channels: { ...prev.channels, [channelId]: entry },
          },
          channelId,
        );
        if (!writeChannelStarsStore(pubkey, next)) return prev;
        manager?.publishStars(next);
        return next;
      });
    },
    [pubkey],
  );

  const starChannel = React.useCallback(
    (channelId: string) => setStarState(channelId, true),
    [setStarState],
  );
  const unstarChannel = React.useCallback(
    (channelId: string) => setStarState(channelId, false),
    [setStarState],
  );

  return {
    starredChannelIds,
    starChannel,
    unstarChannel,
  };
}
