import * as React from "react";

import { relayClient } from "@/shared/api/relayClient";
import {
  boundStarStore,
  DEFAULT_STORE,
  mergeCanonicalSupersession,
  mergeStores,
  readChannelStarsStore,
  starredChannelIdsFromStore,
  storageKey,
  writeChannelStarsStore,
  type ChannelStarEntry,
  type ChannelStarStore,
} from "./channelStarsStorage";
import { ChannelStarSyncManager } from "./channelStarsSync";
import type { RemoteStars } from "./channelStarsSync";

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
  const lastAppliedRemoteTs = React.useRef(0);
  const lastAppliedEventId = React.useRef("");
  // Channels the user changed locally within the current remote second. Their
  // integer-second `updatedAt` ties the remote's, so a late canonical
  // correction would clobber them on the remote-wins tie; the overlay in
  // `mergeCanonicalSupersession` keeps them. Cleared whenever the remote clock
  // strictly advances — a correction for an earlier second is then stale-
  // rejected before it can apply, so the prior second's clicks need no cover.
  const dirtyChannelIds = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    if (!pubkey || !relayUrl) {
      setStore(DEFAULT_STORE);
      lastAppliedRemoteTs.current = 0;
      lastAppliedEventId.current = "";
      dirtyChannelIds.current = new Set();
      return;
    }
    setStore(readChannelStarsStore(pubkey));
    lastAppliedRemoteTs.current = 0;
    lastAppliedEventId.current = "";
    dirtyChannelIds.current = new Set();
    managerRef.current = new ChannelStarSyncManager(pubkey, relayUrl);
    return () => {
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, [pubkey, relayUrl]);

  React.useEffect(() => {
    if (!pubkey) {
      return;
    }
    const key = storageKey(pubkey);
    const handler = (e: StorageEvent) => {
      if (e.key !== key) {
        return;
      }
      setStore(readChannelStarsStore(pubkey));
    };
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("storage", handler);
    };
  }, [pubkey]);

  const applyRemote = React.useCallback(
    (remote: RemoteStars): ((prev: ChannelStarStore) => ChannelStarStore) => {
      return (prev) => {
        if (!pubkey) return prev;
        if (remote.createdAt < lastAppliedRemoteTs.current) return prev;
        // Equal timestamps: the relay/database break ties by `id ASC` — the
        // LOWEST event id is the canonical winner. Apply a strictly-lower id and
        // ignore any id >= the last applied, so the UI converges on the same
        // event the relay stored rather than the largest id seen.
        if (
          remote.createdAt === lastAppliedRemoteTs.current &&
          remote.eventId >= lastAppliedEventId.current
        )
          return prev;
        // A canonical supersession corrects an already-applied same-timestamp
        // LARGER-id head with the true winner: only here may the incoming blob's
        // per-entry values win an equal-`updatedAt` tie. Any other application
        // (bootstrap / live / newer timestamp) merges over optimistic local
        // state with local-wins `mergeStores`.
        const isCanonicalSupersession =
          remote.createdAt === lastAppliedRemoteTs.current &&
          lastAppliedEventId.current !== "" &&
          remote.eventId < lastAppliedEventId.current;
        // A strictly-newer remote second retires every locally-dirty entry: a
        // later correction can only target this new second, so prior clicks
        // need no cover and the set must not grow unbounded.
        if (remote.createdAt > lastAppliedRemoteTs.current)
          dirtyChannelIds.current = new Set();
        lastAppliedRemoteTs.current = remote.createdAt;
        lastAppliedEventId.current = remote.eventId;
        // A canonical correction must not erase a locally-owned entry the user
        // changed within this same second (integer-second `updatedAt` ties the
        // remote's). Overlay the dirty entries back on top of the correction,
        // and never cancel the pending publish — the click still needs to sync.
        const merged = isCanonicalSupersession
          ? mergeCanonicalSupersession(
              prev,
              remote.store,
              dirtyChannelIds.current,
            )
          : mergeStores(prev, remote.store);
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
    });
    return () => {
      cancelled = true;
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
      const entry: ChannelStarEntry = {
        starred,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      setStore((prev) => {
        const next = boundStarStore(
          {
            version: 1,
            channels: { ...prev.channels, [channelId]: entry },
          },
          channelId,
        );
        if (!writeChannelStarsStore(pubkey, next)) return prev;
        // Mark this channel locally-owned for the current remote second so a
        // late canonical correction with the same integer `updatedAt` can't
        // clobber the click before its publish syncs.
        dirtyChannelIds.current.add(channelId);
        managerRef.current?.publishStars(next);
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
