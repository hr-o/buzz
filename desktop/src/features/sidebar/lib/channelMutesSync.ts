import { relayClient } from "@/shared/api/relayClient";
import {
  nip44DecryptFromSelf,
  nip44EncryptToSelf,
  signRelayEvent,
} from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_CHANNEL_MUTES } from "@/shared/constants/kinds";
import {
  clearChannelMutesOutbox,
  mergeStores,
  parseMutePayload,
  writeChannelMutesOutbox,
  type ChannelMuteStore,
} from "./channelMutesStorage";
import {
  advanceWatermark,
  readWatermark,
  runBootstrap,
  type FetchResult,
} from "./sidebarSyncWatermark";

const D_TAG = "channel-mutes";
const BLOB_TYPE = D_TAG;
const DEBOUNCE_MS = 2_000;

// Bounded backoff for a retained pending edit whose publish failed transiently
// (timeout / socket error) on an otherwise-healthy socket, so it does not wait
// for a reconnect that may never fire.
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

export type RemoteMutes = {
  store: ChannelMuteStore;
  createdAt: number;
  eventId: string;
};

async function decryptAndParse(event: RelayEvent): Promise<RemoteMutes | null> {
  try {
    const plaintext = await nip44DecryptFromSelf(event.content);
    const store = parseMutePayload(JSON.parse(plaintext));
    if (!store) return null;
    return { store, createdAt: event.created_at, eventId: event.id };
  } catch {
    return null;
  }
}

export class ChannelMuteSyncManager {
  private pubkey: string;
  private relayUrl: string;
  private debounceTimer: number | null = null;
  private retryTimer: number | null = null;
  private retryDelayMs = RETRY_BASE_MS;
  private lastRemoteCreatedAt: number;
  private pendingStore: ChannelMuteStore | null = null;
  // Monotonic id for the current pending edit. Every publishMutes() bumps it;
  // every scheduled publish/retry captures the value it was queued for. A
  // completion (success or no-op) may only clear pending state via
  // compare-and-swap on this generation, so an older in-flight publish can
  // never erase a newer edit that arrived while it was in flight.
  private pendingGeneration = 0;
  // Publish cycles are serialized: at most one runs at a time. A newer edit
  // queued while a cycle is in flight defers; the in-flight cycle's completion
  // re-drives it. Serialization guarantees there is never more than one
  // fetch/publish sequence touching shared manager state.
  private publishInFlight = false;
  private lastPublishedStore: ChannelMuteStore | null = null;
  private destroyed = false;
  // Per-channel high-water of every `rev` and `updatedAt` this manager has
  // observed (bootstrap, live, reconnect, reconcile, pre-publish, cross-window
  // storage, and initial persisted state). A click reads both so its minted
  // `updatedAt = max(now, maxUpdatedAtSeen)` never regresses below observed
  // state (the read-state logical-monotonic idiom), and `rev = maxRevSeen + 1`
  // wins the resulting same-second tie.
  private highWater = new Map<string, { rev: number; updatedAt: number }>();

  constructor(pubkey: string, relayUrl: string) {
    this.pubkey = pubkey;
    this.relayUrl = relayUrl;
    this.lastRemoteCreatedAt = readWatermark(pubkey, BLOB_TYPE, relayUrl);
  }

  /**
   * Ingest a store into the per-channel high-water. Called synchronously before
   * any merge is applied to React state, so a click that follows reads a current
   * watermark on both dimensions. Monotonic (`Math.max`) and idempotent.
   */
  observe(store: ChannelMuteStore): void {
    for (const [id, entry] of Object.entries(store.channels)) {
      const cur = this.highWater.get(id) ?? { rev: 0, updatedAt: 0 };
      this.highWater.set(id, {
        rev: Math.max(cur.rev, entry.rev),
        updatedAt: Math.max(cur.updatedAt, entry.updatedAt),
      });
    }
  }

  maxRevSeen(id: string): number {
    return this.highWater.get(id)?.rev ?? 0;
  }

  maxUpdatedAtSeen(id: string): number {
    return this.highWater.get(id)?.updatedAt ?? 0;
  }

  async fetchRemoteMutes(): Promise<FetchResult<RemoteMutes>> {
    try {
      const events = await relayClient.fetchEvents({
        kinds: [KIND_CHANNEL_MUTES],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 1,
      });
      if (events.length === 0 || events[0].pubkey !== this.pubkey) {
        return { status: "absent" };
      }
      const event = events[0];
      this.recordRemoteHead(event.created_at);
      const result = await decryptAndParse(event);
      if (!result) {
        return { status: "failed", createdAt: event.created_at };
      }
      this.observe(result.store);
      return {
        status: "found",
        data: result,
        createdAt: result.createdAt,
        eventId: result.eventId,
      };
    } catch {
      return { status: "failed" };
    }
  }

  private recordRemoteHead(createdAt: number): void {
    if (createdAt > this.lastRemoteCreatedAt) {
      this.lastRemoteCreatedAt = createdAt;
    }
    advanceWatermark(this.pubkey, BLOB_TYPE, this.relayUrl, createdAt);
  }

  cancelPendingMutePublish(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  getPendingMuteStore(): ChannelMuteStore | null {
    return this.pendingStore;
  }

  publishMutes(store: ChannelMuteStore): void {
    this.pendingStore = store;
    ++this.pendingGeneration;
    // Persist synchronously so a click made <2s before quit/community-switch
    // survives teardown and resumes on next mount (durable outbox).
    writeChannelMutesOutbox(this.pubkey, store, this.relayUrl);
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    // A fresh edit supersedes any retry scheduled for the previous generation.
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryDelayMs = RETRY_BASE_MS;
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.startCycle();
    }, DEBOUNCE_MS);
  }

  /**
   * Serialize publish cycles: at most one runs at a time. A debounce/retry timer
   * that fires while a cycle is in flight defers — the in-flight cycle's
   * completion re-drives if a pending edit still needs publishing. A newer edit
   * queued during a cycle cannot start its own concurrent cycle, so a stale
   * generation can never publish after a newer edit exists.
   */
  private startCycle(): void {
    if (this.destroyed || this.pendingStore === null) return;
    if (this.publishInFlight) return;
    const store = this.pendingStore;
    const gen = this.pendingGeneration;
    this.publishInFlight = true;
    void this.doPublish(store, gen).finally(() => {
      this.publishInFlight = false;
      if (
        !this.destroyed &&
        this.pendingStore !== null &&
        this.debounceTimer === null &&
        this.retryTimer === null
      ) {
        this.startCycle();
      }
    });
  }

  private async fetchOwnBlobBeforePublish(
    store: ChannelMuteStore,
  ): Promise<ChannelMuteStore> {
    try {
      const events = await relayClient.fetchEvents({
        kinds: [KIND_CHANNEL_MUTES],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 1,
      });
      if (events.length === 0 || events[0].pubkey !== this.pubkey) return store;
      const event = events[0];
      // Record the raw head before decrypt on the pre-publish path too.
      this.recordRemoteHead(event.created_at);
      const remote = await decryptAndParse(event);
      if (!remote) return store;
      this.observe(remote.store);
      // Max-merge: the local edit's per-entry winners survive by construction
      // and any newer remote entries fold in, so no adopt step is needed.
      return mergeStores(store, remote.store);
    } catch {
      return store;
    }
  }

  private isIdenticalToLastPublished(store: ChannelMuteStore): boolean {
    if (!this.lastPublishedStore) return false;
    const lastKeys = Object.keys(this.lastPublishedStore.channels);
    const currentKeys = Object.keys(store.channels);
    if (lastKeys.length !== currentKeys.length) return false;
    for (const key of currentKeys) {
      const last = this.lastPublishedStore.channels[key];
      const current = store.channels[key];
      if (
        !last ||
        last.muted !== current.muted ||
        last.updatedAt !== current.updatedAt ||
        last.rev !== current.rev
      )
        return false;
    }
    return true;
  }

  /**
   * Clear the in-memory pending edit and its durable outbox — but only if the
   * completing publish still owns the current generation. A publish for an
   * older edit that finishes after a newer edit was queued must leave the newer
   * edit (and its retry state) untouched.
   */
  private discardPending(gen: number): void {
    if (gen !== this.pendingGeneration) return;
    this.pendingStore = null;
    clearChannelMutesOutbox(this.pubkey, this.relayUrl);
  }

  /** Schedule a bounded-backoff retry of the retained pending edit. */
  private scheduleRetry(gen: number): void {
    if (this.destroyed || this.pendingStore === null) return;
    // A newer edit has superseded this one; its own timer owns the retry.
    if (gen !== this.pendingGeneration) return;
    if (this.retryTimer !== null) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, RETRY_MAX_MS);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.startCycle();
    }, delay);
  }

  private async doPublish(store: ChannelMuteStore, gen: number): Promise<void> {
    // A newer edit was queued after this publish was scheduled; it owns the
    // pending state and will publish the latest store — abandon this stale run.
    if (gen !== this.pendingGeneration) return;
    try {
      const merged = await this.fetchOwnBlobBeforePublish(store);
      // Guard: manager may have been destroyed while fetchOwnBlobBeforePublish
      // was awaited (community switch during in-flight fetch).
      if (this.destroyed) return;
      // A newer edit was queued while we awaited the pre-publish fetch. It owns
      // convergence now; the serialized cycle re-drives for it once this run
      // unwinds.
      if (gen !== this.pendingGeneration) return;
      if (this.isIdenticalToLastPublished(merged)) {
        this.discardPending(gen);
        return;
      }
      const payload = {
        version: 1,
        channels: merged.channels,
      };
      const ciphertext = await nip44EncryptToSelf(JSON.stringify(payload));
      const createdAt = Math.max(
        Math.floor(Date.now() / 1_000),
        this.lastRemoteCreatedAt + 1,
      );
      const event = await signRelayEvent({
        kind: KIND_CHANNEL_MUTES,
        content: ciphertext,
        createdAt,
        tags: [
          ["d", D_TAG],
          ["t", D_TAG], // relay discoverability; not used in our filters
        ],
      });
      // Final guard immediately before the network call: a newer edit may have
      // been queued during the encrypt/sign await, or the manager destroyed.
      if (this.destroyed || gen !== this.pendingGeneration) return;
      await relayClient.publishEvent(
        event,
        "Timed out publishing channel mutes.",
        "Failed to publish channel mutes.",
      );
      this.recordRemoteHead(event.created_at);
      this.observe(merged);
      // Only claim this store as the published head if it is still the current
      // edit; a newer edit queued mid-flight owns lastPublishedStore now.
      if (gen === this.pendingGeneration) {
        this.lastPublishedStore = merged;
        this.retryDelayMs = RETRY_BASE_MS;
      }
      this.discardPending(gen);
    } catch (error) {
      if (this.destroyed) return;
      // Transient publish failure (timeout / socket error). Keep the pending
      // edit and retry with backoff rather than waiting for a reconnect that a
      // healthy socket never fires. Max-merge makes a duplicate publish
      // idempotent, so a lost-ACK write that the relay actually accepted is
      // harmless to re-send.
      console.warn("[channelMutesSync] publish failed:", error);
      this.scheduleRetry(gen);
    }
  }

  async subscribeToMutes(
    onUpdate: (remote: RemoteMutes) => void,
  ): Promise<() => Promise<void>> {
    return relayClient.subscribeLive(
      {
        kinds: [KIND_CHANNEL_MUTES],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 0,
      },
      (event: RelayEvent) => {
        if (event.pubkey !== this.pubkey) return;
        // Record the raw head before decrypt so an undecryptable live event
        // still advances the watermark and blocks future seed-publish.
        this.recordRemoteHead(event.created_at);
        void decryptAndParse(event).then((result) => {
          if (result) {
            this.observe(result.store);
            onUpdate(result);
          }
        });
      },
    );
  }

  /**
   * Fetches the remote blob on first mount, records the remote head, and
   * delegates the seed/hold/apply-remote decision to `runBootstrap`.
   */
  async bootstrap(localStore: ChannelMuteStore) {
    // Seed the high-water from the caller's persisted local store so a click
    // before the remote fetch resolves already reflects retained entries.
    this.observe(localStore);
    const fetchResult = await this.fetchRemoteMutes();
    return runBootstrap({
      fetchResult,
      lastHead: this.lastRemoteCreatedAt,
      localStore,
      isLocalNonEmpty: (s) => Object.keys(s.channels).length > 0,
      publishFn: (s) => this.publishMutes(s),
    });
  }

  destroy(): void {
    // Cancel any pending publish and mark this manager as destroyed so any
    // in-flight doPublish() calls abort before reaching relayClient.
    // Debounce-window changes are NOT lost: publishMutes persisted them to the
    // durable outbox synchronously, and the next mount resumes them. Flushing
    // here is still avoided — it could publish relay A's state to relay B via
    // the shared relayClient singleton.
    this.destroyed = true;
    this.cancelPendingMutePublish();
    this.pendingStore = null;
  }
}
