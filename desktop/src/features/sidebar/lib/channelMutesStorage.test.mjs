import assert from "node:assert/strict";
import test from "node:test";

import {
  boundMuteStore,
  MAX_CHANNEL_MUTE_ENTRIES,
  mergeStores,
  parseMutePayload,
  mutedChannelIdsFromStore,
} from "./channelMutesStorage.ts";

// ── parseMutePayload ──────────────────────────────────────────────────────────

test("parseMutePayload: valid payload with channels returns store (rev preserved)", () => {
  const payload = {
    version: 1,
    channels: {
      "chan-1": { muted: true, updatedAt: 1000, rev: 3 },
      "chan-2": { muted: false, updatedAt: 2000, rev: 0 },
    },
  };
  assert.deepEqual(parseMutePayload(payload), payload);
});

test("parseMutePayload: missing rev normalizes to 0 (old-build blob, entry kept)", () => {
  const result = parseMutePayload({
    version: 1,
    channels: { "chan-1": { muted: true, updatedAt: 1000 } },
  });
  assert.deepEqual(result.channels["chan-1"], {
    muted: true,
    updatedAt: 1000,
    rev: 0,
  });
});

test("parseMutePayload: malformed rev (string / negative / non-integer / NaN) normalizes to 0", () => {
  const result = parseMutePayload({
    version: 1,
    channels: {
      str: { muted: true, updatedAt: 1, rev: "5" },
      neg: { muted: true, updatedAt: 1, rev: -2 },
      frac: { muted: true, updatedAt: 1, rev: 1.5 },
      nan: { muted: true, updatedAt: 1, rev: NaN },
    },
  });
  for (const id of ["str", "neg", "frac", "nan"]) {
    assert.equal(result.channels[id].rev, 0, `${id} rev normalized to 0`);
    assert.equal(result.channels[id].muted, true, `${id} entry kept`);
  }
});

test("parseMutePayload: missing version returns null", () => {
  assert.equal(
    parseMutePayload({
      channels: { "chan-1": { muted: true, updatedAt: 1 } },
    }),
    null,
  );
});

test("parseMutePayload: wrong version returns null", () => {
  assert.equal(
    parseMutePayload({
      version: 2,
      channels: { "chan-1": { muted: true, updatedAt: 1 } },
    }),
    null,
  );
});

test("parseMutePayload: null / non-object input returns null", () => {
  assert.equal(parseMutePayload(null), null);
  assert.equal(parseMutePayload("string"), null);
  assert.equal(parseMutePayload(42), null);
  assert.equal(parseMutePayload(true), null);
});

test("parseMutePayload: malformed channel entries missing muted/updatedAt are filtered out", () => {
  const result = parseMutePayload({
    version: 1,
    channels: {
      "no-muted": { updatedAt: 1000 },
      "no-updated-at": { muted: true },
      valid: { muted: false, updatedAt: 500 },
      "muted-wrong-type": { muted: "yes", updatedAt: 1000 },
      "updated-at-wrong-type": { muted: true, updatedAt: "now" },
      null: null,
    },
  });
  assert.deepEqual(result, {
    version: 1,
    channels: { valid: { muted: false, updatedAt: 500, rev: 0 } },
  });
});

test("parseMutePayload: NaN/Infinity/negative updatedAt entries are filtered out", () => {
  const result = parseMutePayload({
    version: 1,
    channels: {
      nan: { muted: true, updatedAt: NaN },
      inf: { muted: true, updatedAt: Infinity },
      "neg-inf": { muted: true, updatedAt: -Infinity },
      neg: { muted: true, updatedAt: -1 },
      valid: { muted: true, updatedAt: 100, rev: 2 },
    },
  });
  assert.deepEqual(result, {
    version: 1,
    channels: { valid: { muted: true, updatedAt: 100, rev: 2 } },
  });
});

test("parseMutePayload: empty channels / no channels key returns empty store", () => {
  assert.deepEqual(parseMutePayload({ version: 1, channels: {} }), {
    version: 1,
    channels: {},
  });
  assert.deepEqual(parseMutePayload({ version: 1 }), {
    version: 1,
    channels: {},
  });
});

// ── mergeStores: tuple order (updatedAt → rev → value) ────────────────────────

const E = (muted, updatedAt, rev) => ({ muted, updatedAt, rev });
const S = (entry) => ({ version: 1, channels: { c: entry } });

test("mergeStores: non-overlapping channels returns union", () => {
  const result = mergeStores(
    { version: 1, channels: { a: E(true, 100, 1) } },
    { version: 1, channels: { b: E(false, 200, 1) } },
  );
  assert.deepEqual(result, {
    version: 1,
    channels: { a: E(true, 100, 1), b: E(false, 200, 1) },
  });
});

test("mergeStores: strictly-later updatedAt wins regardless of rev (primary key)", () => {
  // Later updatedAt with LOWER rev still wins — updatedAt is primary. This is
  // the old-build interop case: an old build's rev-0 fresh edit beats a stale
  // rev-bearing new-build entry.
  const result = mergeStores(S(E(false, 200, 0)), S(E(true, 100, 7)));
  assert.deepEqual(result.channels.c, E(false, 200, 0));
});

test("mergeStores: equal updatedAt → higher rev wins (same-second tiebreak)", () => {
  const result = mergeStores(S(E(false, 100, 5)), S(E(true, 100, 2)));
  assert.deepEqual(result.channels.c, E(false, 100, 5));
});

test("mergeStores: equal updatedAt AND equal rev → muted=true wins (leaf)", () => {
  const result = mergeStores(S(E(false, 100, 3)), S(E(true, 100, 3)));
  assert.deepEqual(result.channels.c, E(true, 100, 3));
});

test("mergeStores: unmute with higher updatedAt overrides mute", () => {
  const result = mergeStores(S(E(true, 100, 9)), S(E(false, 999, 1)));
  assert.deepEqual(result.channels.c, E(false, 999, 1));
});

test("mergeStores: empty local / empty remote / both empty", () => {
  assert.deepEqual(
    mergeStores({ version: 1, channels: {} }, S(E(true, 42, 1))).channels.c,
    E(true, 42, 1),
  );
  assert.deepEqual(
    mergeStores(S(E(false, 10, 2)), { version: 1, channels: {} }).channels.c,
    E(false, 10, 2),
  );
  assert.deepEqual(
    mergeStores({ version: 1, channels: {} }, { version: 1, channels: {} }),
    { version: 1, channels: {} },
  );
});

// ── mergeStores: algebra (commutativity, associativity, idempotence) ──────────

function randEntry(rng) {
  return {
    muted: rng() > 0.5,
    updatedAt: Math.floor(rng() * 5),
    rev: Math.floor(rng() * 5),
  };
}
function randStore(rng, ids) {
  const channels = {};
  for (const id of ids) if (rng() > 0.3) channels[id] = randEntry(rng);
  return { version: 1, channels };
}
// Deterministic LCG so failures reproduce.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("mergeStores: commutative — merge(a,b) === merge(b,a)", () => {
  const rng = lcg(12345);
  const ids = ["a", "b", "c", "d"];
  for (let i = 0; i < 200; i++) {
    const a = randStore(rng, ids);
    const b = randStore(rng, ids);
    assert.deepEqual(mergeStores(a, b), mergeStores(b, a));
  }
});

test("mergeStores: associative — merge(merge(a,b),c) === merge(a,merge(b,c))", () => {
  const rng = lcg(67890);
  const ids = ["a", "b", "c", "d"];
  for (let i = 0; i < 200; i++) {
    const a = randStore(rng, ids);
    const b = randStore(rng, ids);
    const c = randStore(rng, ids);
    assert.deepEqual(
      mergeStores(mergeStores(a, b), c),
      mergeStores(a, mergeStores(b, c)),
    );
  }
});

test("mergeStores: idempotent — merge(a, merge(a,b)) === merge(a,b)", () => {
  const rng = lcg(24680);
  const ids = ["a", "b", "c", "d"];
  for (let i = 0; i < 200; i++) {
    const a = randStore(rng, ids);
    const b = randStore(rng, ids);
    const ab = mergeStores(a, b);
    assert.deepEqual(mergeStores(a, ab), ab);
    assert.deepEqual(mergeStores(ab, ab), ab);
  }
});

// ── v1-blob bidirectional compatibility ───────────────────────────────────────

test("v1 compat: a rev-carrying blob round-trips through a rev-less parser view", () => {
  // Simulate an old build reading our blob: JSON-serialize our rev-carrying
  // payload, parse it back — version stays 1 so it is NOT rejected, and the
  // core fields survive (old build simply ignores rev).
  const ours = {
    version: 1,
    channels: { c: { muted: true, updatedAt: 100, rev: 7 } },
  };
  const roundTripped = parseMutePayload(JSON.parse(JSON.stringify(ours)));
  assert.equal(roundTripped.version, 1, "version stays 1 — old build accepts");
  assert.equal(roundTripped.channels.c.muted, true);
  assert.equal(roundTripped.channels.c.updatedAt, 100);
});

test("v1 compat: old-build unmute (no rev, updatedAt+1) beats our stale mute", () => {
  // New build wrote {muted:true, rev:7, updatedAt:t}; old build (no rev)
  // unmutes producing {muted:false, updatedAt:t+1}. The unmute wins on the
  // primary updatedAt key — old builds can still edit upgraded channels.
  const ours = S(E(true, 100, 7));
  const oldBuildUnmute = parseMutePayload({
    version: 1,
    channels: { c: { muted: false, updatedAt: 101 } },
  });
  assert.deepEqual(mergeStores(ours, oldBuildUnmute).channels.c, {
    muted: false,
    updatedAt: 101,
    rev: 0,
  });
});

// ── boundMuteStore ────────────────────────────────────────────────────────────

test("boundMuteStore: retains newest entries regardless of muted value", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_MUTE_ENTRIES }, (_, i) => [
      `active-${i}`,
      E(true, i + 1, 0),
    ]),
  );
  channels["old-false"] = E(false, 0, 0);
  channels["new-false"] = E(false, 9999, 0);
  const result = boundMuteStore({ version: 1, channels });
  assert.equal(Object.keys(result.channels).length, MAX_CHANNEL_MUTE_ENTRIES);
  assert.equal(result.channels["old-false"], undefined);
  assert.deepEqual(result.channels["new-false"], E(false, 9999, 0));
  assert.equal(result.channels["active-0"], undefined);
});

test("boundMuteStore: uses channel ID as an updatedAt tie-breaker", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_MUTE_ENTRIES + 1 }, (_, i) => [
      `channel-${String(MAX_CHANNEL_MUTE_ENTRIES - i).padStart(3, "0")}`,
      E(true, 1, 0),
    ]),
  );
  const result = boundMuteStore({ version: 1, channels });
  assert.equal(result.channels["channel-000"], undefined);
  assert.deepEqual(result.channels["channel-500"], E(true, 1, 0));
});

test("boundMuteStore: preserves a same-second mutation by key", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_MUTE_ENTRIES }, (_, i) => [
      `z-channel-${String(i).padStart(3, "0")}`,
      E(true, 1, 0),
    ]),
  );
  channels["a-target"] = E(false, 1, 1);
  const result = boundMuteStore({ version: 1, channels }, "a-target");
  assert.equal(Object.keys(result.channels).length, MAX_CHANNEL_MUTE_ENTRIES);
  assert.deepEqual(result.channels["a-target"], E(false, 1, 1));
  assert.equal(result.channels["z-channel-000"], undefined);
});

test("mergeStores: a fresh at-capacity unmute defeats an older remote mute", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_MUTE_ENTRIES }, (_, i) => [
      `active-${i}`,
      E(true, i + 1, 0),
    ]),
  );
  channels.unmuted = E(false, 9999, 1);
  const bounded = boundMuteStore({ version: 1, channels });
  const result = mergeStores(bounded, {
    version: 1,
    channels: { unmuted: E(true, 9998, 5) },
  });
  assert.deepEqual(result.channels.unmuted, E(false, 9999, 1));
});

test("mergeStores: evicted remote ID re-enters and the oldest state is re-trimmed", () => {
  const localChannels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_MUTE_ENTRIES }, (_, i) => [
      `active-${i}`,
      E(true, i + 10, 0),
    ]),
  );
  const result = mergeStores(
    { version: 1, channels: localChannels },
    {
      version: 1,
      channels: {
        "evicted-id": E(true, 9999, 0),
        "active-0": E(false, 9998, 0),
      },
    },
  );
  assert.equal(Object.keys(result.channels).length, MAX_CHANNEL_MUTE_ENTRIES);
  assert.deepEqual(result.channels["evicted-id"], E(true, 9999, 0));
  assert.deepEqual(result.channels["active-0"], E(false, 9998, 0));
  assert.equal(result.channels["active-1"], undefined);
});

// ── Eviction / remount (finding 3) ────────────────────────────────────────────

// Easy branch: X evicted at an OLDER second → remount (high-water lost) → click
// X at the current second → merge a remote carrying X at a high rev but an old
// updatedAt. The click's newer updatedAt wins on the primary key; the lost rev
// high-water is irrelevant. Closed by construction for all cross-second cases.
test("finding 3 easy branch: a fresh click beats an evicted high-rev entry at an older updatedAt", () => {
  // Remount state: the user clicks X fresh at updatedAt=now, empty high-water
  // (evicted), so rev mints to 1.
  const click = S(E(true, 1000, 1));
  // The previously observed remote X sits at an OLD updatedAt with a high rev.
  const remote = S(E(false, 500, 100));
  const merged = mergeStores(click, remote);
  assert.deepEqual(
    merged.channels.c,
    E(true, 1000, 1),
    "fresh click wins on the primary updatedAt key",
  );
});

// Hard branch (Thufir's exact equal-second counterexample): >500 entries all at
// the CURRENT second → X evicted by the id tiebreak (not because it is old) →
// remount in the same second → click X at rev 1 (empty high-water) → merge the
// previously observed remote X at rev 100, EQUAL updatedAt. updatedAt ties, rev
// decides, 100 > 1 — the click LOSES. Documented deterministic residual, proven
// here as the hard branch (not disguised as safety).
test("finding 3 hard branch: equal-second evicted click (rev 1) loses to observed remote (rev 100)", () => {
  const NOW = 777;
  // Remount click on the evicted channel: empty high-water → rev 1, updatedAt=NOW.
  const click = S(E(true, NOW, 1));
  // The previously observed remote for the same channel at the same second,
  // rev 100 (it may precede the remount — not genuinely concurrent).
  const remote = S(E(false, NOW, 100));
  const merged = mergeStores(click, remote);
  assert.deepEqual(
    merged.channels.c,
    E(false, NOW, 100),
    "equal updatedAt → higher rev wins deterministically (documented residual)",
  );
  // Deterministic either merge order — a lost click, never a divergence.
  assert.deepEqual(mergeStores(remote, click).channels.c, E(false, NOW, 100));
});

// ── mutedChannelIdsFromStore ────────────────────────────────────────────────

test("mutedChannelIdsFromStore: returns set of IDs where muted=true", () => {
  const result = mutedChannelIdsFromStore({
    version: 1,
    channels: {
      a: E(true, 100, 0),
      b: E(true, 200, 0),
      c: E(false, 300, 0),
    },
  });
  assert.deepEqual([...result].sort(), ["a", "b"]);
});

test("mutedChannelIdsFromStore: all-false / empty returns empty set", () => {
  assert.equal(
    mutedChannelIdsFromStore({
      version: 1,
      channels: { x: E(false, 1, 0) },
    }).size,
    0,
  );
  assert.equal(mutedChannelIdsFromStore({ version: 1, channels: {} }).size, 0);
});
