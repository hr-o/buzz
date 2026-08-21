import { relayClient } from "@/shared/api/relayClient";
import {
  nip44DecryptFromSelf,
  nip44EncryptToSelf,
  signRelayEvent,
} from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_CHANNEL_SECTIONS } from "@/shared/constants/kinds";
import {
  clearChannelSectionsOutbox,
  parseChannelSectionPayload,
  writeChannelSectionsOutbox,
  type ChannelSection,
  type ChannelSectionStore,
} from "./channelSectionsStorage";
import {
  advanceWatermark,
  readWatermark,
  runBootstrap,
  type FetchResult,
} from "./sidebarSyncWatermark";

const D_TAG = "channel-sections";
const BLOB_TYPE = D_TAG;
const DEBOUNCE_MS = 2_000;

// The relay rejects events more than ±15 minutes (900s) from server time
// (`MAX_TIMESTAMP_DRIFT_SECS` in ingest.rs). Clamp our published `created_at`
// well inside that window so a skewed remote head can never make us manufacture
// an unbounded future timestamp that wedges every subsequent publish. 840s
// leaves ~60s of transit margin while still letting us win LWW against any
// legitimately-timestamped head.
const MAX_PUBLISH_FUTURE_SECS = 840;

// Bounded backoff for a retained pending edit whose publish failed transiently
// (timeout / socket error) on an otherwise-healthy socket, so it does not wait
// for a reconnect that may never fire.
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

export type RemoteSections = {
  store: ChannelSectionStore;
  createdAt: number;
  eventId: string;
};

/**
 * Outcome of the pre-publish head check.
 *
 * - `publish` — local edit is at or ahead of the head; publish it.
 * - `adopt`   — a newer remote head exists; the local edit lost whole-blob
 *               LWW and must be discarded in favour of the remote store so UI
 *               and relay converge (see the fix-2 design note). The manager
 *               hands the remote back to the hook and never publishes.
 */
type PublishDecision =
  | { kind: "publish"; store: ChannelSectionStore }
  | { kind: "adopt"; remote: RemoteSections };

async function decryptAndParse(
  event: RelayEvent,
): Promise<RemoteSections | null> {
  try {
    const plaintext = await nip44DecryptFromSelf(event.content);
    const store = parseChannelSectionPayload(JSON.parse(plaintext));
    if (!store) return null;
    return { store, createdAt: event.created_at, eventId: event.id };
  } catch {
    return null;
  }
}

export class ChannelSectionSyncManager {
  private pubkey: string;
  private relayUrl: string;
  private debounceTimer: number | null = null;
  private retryTimer: number | null = null;
  private retryDelayMs = RETRY_BASE_MS;
  private lastRemoteCreatedAt: number;
  private pendingStore: ChannelSectionStore | null = null;
  private lastPublishedStore: ChannelSectionStore | null = null;
  private destroyed = false;
  // Set by the hook so an adopted remote head (local edit lost LWW, or a relay
  // conflict rejection) is written through to React state + localStorage.
  private onRemoteAdopted: ((remote: RemoteSections) => void) | null = null;

  constructor(pubkey: string, relayUrl: string) {
    this.pubkey = pubkey;
    this.relayUrl = relayUrl;
    // Hydrate from localStorage so we never seed-publish if a remote blob has
    // been seen in a prior session.
    this.lastRemoteCreatedAt = readWatermark(pubkey, BLOB_TYPE, relayUrl);
  }

  /** Register the hook's adopt-remote sink (write-through to UI + storage). */
  setOnRemoteAdopted(cb: (remote: RemoteSections) => void): void {
    this.onRemoteAdopted = cb;
  }

  async fetchRemoteSections(): Promise<FetchResult<RemoteSections>> {
    try {
      const events = await relayClient.fetchEvents({
        kinds: [KIND_CHANNEL_SECTIONS],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 1,
      });
      if (events.length === 0 || events[0].pubkey !== this.pubkey) {
        return { status: "absent" };
      }
      const event = events[0];
      // An event exists — record its created_at regardless of whether we can
      // decrypt it, so seed-publish is blocked even when the payload is
      // unreadable (e.g. wrong key).
      this.recordRemoteHead(event.created_at);
      const result = await decryptAndParse(event);
      if (!result) {
        return { status: "failed", createdAt: event.created_at };
      }
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

  /** Update in-memory + persisted watermark. */
  private recordRemoteHead(createdAt: number): void {
    if (createdAt > this.lastRemoteCreatedAt) {
      this.lastRemoteCreatedAt = createdAt;
    }
    advanceWatermark(this.pubkey, BLOB_TYPE, this.relayUrl, createdAt);
  }

  cancelPendingPublish(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  getPendingStore(): ChannelSectionStore | null {
    return this.pendingStore;
  }

  /**
   * Adopt a remote store that superseded a local edit: hand it to the hook for
   * write-through, advance the watermark, and drop the losing pending edit —
   * including the durable outbox, so the outbox can never replay an edit that
   * adopt just decided lost (which would reintroduce divergence).
   */
  private adoptRemote(remote: RemoteSections): void {
    this.recordRemoteHead(remote.createdAt);
    this.discardPending();
    this.lastPublishedStore = remote.store;
    if (this.destroyed) return;
    this.onRemoteAdopted?.(remote);
  }

  /** Clear both the in-memory pending edit and its durable outbox copy. */
  private discardPending(): void {
    this.pendingStore = null;
    clearChannelSectionsOutbox(this.pubkey, this.relayUrl);
  }

  publishSections(store: ChannelSectionStore): void {
    this.pendingStore = store;
    // Persist synchronously so an edit made <2s before quit/community-switch
    // survives teardown and resumes on next mount (fix-3 durable outbox).
    writeChannelSectionsOutbox(this.pubkey, store, this.relayUrl);
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.doPublish(store);
    }, DEBOUNCE_MS);
  }

  private async fetchOwnBlobBeforePublish(
    store: ChannelSectionStore,
  ): Promise<PublishDecision> {
    try {
      const events = await relayClient.fetchEvents({
        kinds: [KIND_CHANNEL_SECTIONS],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 1,
      });
      if (events.length === 0 || events[0].pubkey !== this.pubkey)
        return { kind: "publish", store };
      const event = events[0];
      // Snapshot the watermark before advancing it: after recordRemoteHead
      // runs, lastRemoteCreatedAt equals event.created_at, so the LWW
      // comparison remote.createdAt > lastRemoteCreatedAt would always be
      // false and silently suppress the adopt.
      const headBeforeFetch = this.lastRemoteCreatedAt;
      this.recordRemoteHead(event.created_at);
      const remote = await decryptAndParse(event);
      if (!remote) return { kind: "publish", store };
      // Sections use whole-blob LWW: a newer remote head wins, and the local
      // edit is adopted-away rather than silently republished as remote content
      // while the UI keeps showing the edit.
      if (remote.createdAt > headBeforeFetch) {
        return { kind: "adopt", remote };
      }
      return { kind: "publish", store };
    } catch {
      return { kind: "publish", store };
    }
  }

  private isIdenticalToLastPublished(store: ChannelSectionStore): boolean {
    if (!this.lastPublishedStore) return false;
    const lastSections = this.lastPublishedStore.sections;
    const currentSections = store.sections;
    if (lastSections.length !== currentSections.length) return false;
    for (let i = 0; i < currentSections.length; i++) {
      const last = lastSections[i] as ChannelSection | undefined;
      const current = currentSections[i] as ChannelSection;
      if (
        !last ||
        last.id !== current.id ||
        last.name !== current.name ||
        last.icon !== current.icon ||
        last.order !== current.order
      )
        return false;
    }
    const lastAssignKeys = Object.keys(this.lastPublishedStore.assignments);
    const currentAssignKeys = Object.keys(store.assignments);
    if (lastAssignKeys.length !== currentAssignKeys.length) return false;
    for (const key of currentAssignKeys) {
      if (this.lastPublishedStore.assignments[key] !== store.assignments[key])
        return false;
    }
    return true;
  }

  /** Schedule a bounded-backoff retry of the retained pending edit. */
  private scheduleRetry(): void {
    if (this.destroyed || this.pendingStore === null) return;
    if (this.retryTimer !== null) return;
    const store = this.pendingStore;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, RETRY_MAX_MS);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.doPublish(store);
    }, delay);
  }

  private async doPublish(store: ChannelSectionStore): Promise<void> {
    try {
      const decision = await this.fetchOwnBlobBeforePublish(store);
      // Guard: manager may have been destroyed while fetchOwnBlobBeforePublish
      // was awaited (community switch during in-flight fetch). If so, abort
      // before touching the relay.
      if (this.destroyed) return;
      if (decision.kind === "adopt") {
        this.adoptRemote(decision.remote);
        return;
      }
      const merged = decision.store;
      if (this.isIdenticalToLastPublished(merged)) {
        this.discardPending();
        return;
      }
      const payload = {
        version: 1,
        sections: merged.sections,
        assignments: merged.assignments,
      };
      const ciphertext = await nip44EncryptToSelf(JSON.stringify(payload));
      const now = Math.floor(Date.now() / 1_000);
      // Clamp inside the relay's future-drift window: never manufacture a
      // timestamp so far ahead that this or a later publish is rejected for
      // drift and wedges. If a skewed remote head sits beyond the window we
      // will lose LWW and adopt it on conflict rather than walking past it.
      const createdAt = Math.min(
        Math.max(now, this.lastRemoteCreatedAt + 1),
        now + MAX_PUBLISH_FUTURE_SECS,
      );
      const event = await signRelayEvent({
        kind: KIND_CHANNEL_SECTIONS,
        content: ciphertext,
        createdAt,
        tags: [
          ["d", D_TAG],
          ["t", D_TAG], // relay discoverability; not used in our filters
        ],
      });
      // Final guard immediately before the network call — sign/encrypt are
      // synchronous-ish but cheap; the relay socket may have moved to a
      // different community by the time we reach this point.
      if (this.destroyed) return;
      await relayClient.publishEvent(
        event,
        "Timed out publishing channel sections.",
        "Failed to publish channel sections.",
      );
      this.recordRemoteHead(event.created_at);
      this.lastPublishedStore = merged;
      this.discardPending();
      this.retryDelayMs = RETRY_BASE_MS;
    } catch (error) {
      if (this.destroyed) return;
      // The relay rejects a strictly-losing coordinate write with an OK false
      // conflict (fix-4). Treat it as a lost race: refetch the head and adopt
      // it so we converge instead of retrying a write that can never win.
      if (isConflictRejection(error)) {
        const head = await this.fetchRemoteSections();
        if (this.destroyed) return;
        if (head.status === "found") {
          this.adoptRemote(head.data);
        } else {
          this.scheduleRetry();
        }
        return;
      }
      // Transient failure (timeout / socket error): keep the pending edit and
      // retry with backoff rather than waiting for a reconnect that a healthy
      // socket never fires.
      console.warn("[channelSectionsSync] publish failed:", error);
      this.scheduleRetry();
    }
  }

  async subscribeToSections(
    onUpdate: (remote: RemoteSections) => void,
  ): Promise<() => Promise<void>> {
    return relayClient.subscribeLive(
      {
        kinds: [KIND_CHANNEL_SECTIONS],
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
  async bootstrap(localStore: ChannelSectionStore) {
    const fetchResult = await this.fetchRemoteSections();
    return runBootstrap({
      fetchResult,
      lastHead: this.lastRemoteCreatedAt,
      localStore,
      isLocalNonEmpty: (s) => s.sections.length > 0,
      publishFn: (s) => this.publishSections(s),
    });
  }

  destroy(): void {
    // Cancel any pending publish and mark this manager as destroyed so any
    // in-flight doPublish() calls abort before reaching relayClient.
    // Debounce-window changes are NOT lost: publishSections persisted them to
    // the durable outbox synchronously, and the next mount resumes them.
    // Flushing here is still avoided — it could publish relay A's sections to
    // relay B via the shared relayClient singleton.
    this.destroyed = true;
    this.cancelPendingPublish();
    this.pendingStore = null;
  }
}

/** True when a publish error is the relay's stale-coordinate conflict (fix-4). */
function isConflictRejection(error: unknown): boolean {
  return (
    error instanceof Error && error.message.toLowerCase().includes("conflict")
  );
}
