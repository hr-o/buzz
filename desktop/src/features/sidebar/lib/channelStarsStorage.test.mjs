import assert from "node:assert/strict";
import test from "node:test";

import {
  boundStarStore,
  MAX_CHANNEL_STAR_ENTRIES,
  mergeStores,
  parseStarPayload,
  starredChannelIdsFromStore,
} from "./channelStarsStorage.ts";

// ── parseStarPayload ──────────────────────────────────────────────────────────

test("parseStarPayload: valid payload with channels returns store (rev preserved)", () => {
  const payload = {
    version: 1,
    channels: {
      "chan-1": { starred: true, updatedAt: 1000, rev: 3 },
      "chan-2": { starred: false, updatedAt: 2000, rev: 0 },
    },
  };
  assert.deepEqual(parseStarPayload(payload), payload);
});

test("parseStarPayload: missing rev normalizes to 0 (old-build blob, entry kept)", () => {
  const result = parseStarPayload({
    version: 1,
    channels: { "chan-1": { starred: true, updatedAt: 1000 } },
  });
  assert.deepEqual(result.channels["chan-1"], {
    starred: true,
    updatedAt: 1000,
    rev: 0,
  });
});

test("parseStarPayload: malformed rev (string / negative / non-integer / NaN) normalizes to 0", () => {
  const result = parseStarPayload({
    version: 1,
    channels: {
      str: { starred: true, updatedAt: 1, rev: "5" },
      neg: { starred: true, updatedAt: 1, rev: -2 },
      frac: { starred: true, updatedAt: 1, rev: 1.5 },
      nan: { starred: true, updatedAt: 1, rev: NaN },
    },
  });
  for (const id of ["str", "neg", "frac", "nan"]) {
    assert.equal(result.channels[id].rev, 0, `${id} rev normalized to 0`);
    assert.equal(result.channels[id].starred, true, `${id} entry kept`);
  }
});

test("parseStarPayload: missing version returns null", () => {
  assert.equal(
    parseStarPayload({
      channels: { "chan-1": { starred: true, updatedAt: 1 } },
    }),
    null,
  );
});

test("parseStarPayload: wrong version returns null", () => {
  assert.equal(
    parseStarPayload({
      version: 2,
      channels: { "chan-1": { starred: true, updatedAt: 1 } },
    }),
    null,
  );
});

test("parseStarPayload: null / non-object input returns null", () => {
  assert.equal(parseStarPayload(null), null);
  assert.equal(parseStarPayload("string"), null);
  assert.equal(parseStarPayload(42), null);
  assert.equal(parseStarPayload(true), null);
});

test("parseStarPayload: malformed channel entries missing starred/updatedAt are filtered out", () => {
  const result = parseStarPayload({
    version: 1,
    channels: {
      "no-starred": { updatedAt: 1000 },
      "no-updated-at": { starred: true },
      valid: { starred: false, updatedAt: 500 },
      "starred-wrong-type": { starred: "yes", updatedAt: 1000 },
      "updated-at-wrong-type": { starred: true, updatedAt: "now" },
      null: null,
    },
  });
  assert.deepEqual(result, {
    version: 1,
    channels: { valid: { starred: false, updatedAt: 500, rev: 0 } },
  });
});

test("parseStarPayload: NaN/Infinity/negative updatedAt entries are filtered out", () => {
  const result = parseStarPayload({
    version: 1,
    channels: {
      nan: { starred: true, updatedAt: NaN },
      inf: { starred: true, updatedAt: Infinity },
      "neg-inf": { starred: true, updatedAt: -Infinity },
      neg: { starred: true, updatedAt: -1 },
      valid: { starred: true, updatedAt: 100, rev: 2 },
    },
  });
  assert.deepEqual(result, {
    version: 1,
    channels: { valid: { starred: true, updatedAt: 100, rev: 2 } },
  });
});

test("parseStarPayload: empty channels / no channels key returns empty store", () => {
  assert.deepEqual(parseStarPayload({ version: 1, channels: {} }), {
    version: 1,
    channels: {},
  });
  assert.deepEqual(parseStarPayload({ version: 1 }), {
    version: 1,
    channels: {},
  });
});

// ── mergeStores: tuple order (updatedAt → rev → value) ────────────────────────

const E = (starred, updatedAt, rev) => ({ starred, updatedAt, rev });
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

test("mergeStores: equal updatedAt AND equal rev → starred=true wins (leaf)", () => {
  const result = mergeStores(S(E(false, 100, 3)), S(E(true, 100, 3)));
  assert.deepEqual(result.channels.c, E(true, 100, 3));
});

test("mergeStores: unstar with higher updatedAt overrides star", () => {
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
    starred: rng() > 0.5,
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
    channels: { c: { starred: true, updatedAt: 100, rev: 7 } },
  };
  const roundTripped = parseStarPayload(JSON.parse(JSON.stringify(ours)));
  assert.equal(roundTripped.version, 1, "version stays 1 — old build accepts");
  assert.equal(roundTripped.channels.c.starred, true);
  assert.equal(roundTripped.channels.c.updatedAt, 100);
});

test("v1 compat: old-build unstar (no rev, updatedAt+1) beats our stale star", () => {
  // New build wrote {starred:true, rev:7, updatedAt:t}; old build (no rev)
  // unstars producing {starred:false, updatedAt:t+1}. The unstar wins on the
  // primary updatedAt key — old builds can still edit upgraded channels.
  const ours = S(E(true, 100, 7));
  const oldBuildUnstar = parseStarPayload({
    version: 1,
    channels: { c: { starred: false, updatedAt: 101 } },
  });
  assert.deepEqual(mergeStores(ours, oldBuildUnstar).channels.c, {
    starred: false,
    updatedAt: 101,
    rev: 0,
  });
});

// ── boundStarStore ────────────────────────────────────────────────────────────

test("boundStarStore: retains newest entries regardless of starred value", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_STAR_ENTRIES }, (_, i) => [
      `active-${i}`,
      E(true, i + 1, 0),
    ]),
  );
  channels["old-false"] = E(false, 0, 0);
  channels["new-false"] = E(false, 9999, 0);
  const result = boundStarStore({ version: 1, channels });
  assert.equal(Object.keys(result.channels).length, MAX_CHANNEL_STAR_ENTRIES);
  assert.equal(result.channels["old-false"], undefined);
  assert.deepEqual(result.channels["new-false"], E(false, 9999, 0));
  assert.equal(result.channels["active-0"], undefined);
});

test("boundStarStore: uses channel ID as an updatedAt tie-breaker", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_STAR_ENTRIES + 1 }, (_, i) => [
      `channel-${String(MAX_CHANNEL_STAR_ENTRIES - i).padStart(3, "0")}`,
      E(true, 1, 0),
    ]),
  );
  const result = boundStarStore({ version: 1, channels });
  assert.equal(result.channels["channel-000"], undefined);
  assert.deepEqual(result.channels["channel-500"], E(true, 1, 0));
});

test("boundStarStore: preserves a same-second mutation by key", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_STAR_ENTRIES }, (_, i) => [
      `z-channel-${String(i).padStart(3, "0")}`,
      E(true, 1, 0),
    ]),
  );
  channels["a-target"] = E(false, 1, 1);
  const result = boundStarStore({ version: 1, channels }, "a-target");
  assert.equal(Object.keys(result.channels).length, MAX_CHANNEL_STAR_ENTRIES);
  assert.deepEqual(result.channels["a-target"], E(false, 1, 1));
  assert.equal(result.channels["z-channel-000"], undefined);
});

test("mergeStores: a fresh at-capacity unstar defeats an older remote star", () => {
  const channels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_STAR_ENTRIES }, (_, i) => [
      `active-${i}`,
      E(true, i + 1, 0),
    ]),
  );
  channels.unstarred = E(false, 9999, 1);
  const bounded = boundStarStore({ version: 1, channels });
  const result = mergeStores(bounded, {
    version: 1,
    channels: { unstarred: E(true, 9998, 5) },
  });
  assert.deepEqual(result.channels.unstarred, E(false, 9999, 1));
});

test("mergeStores: evicted remote ID re-enters and the oldest state is re-trimmed", () => {
  const localChannels = Object.fromEntries(
    Array.from({ length: MAX_CHANNEL_STAR_ENTRIES }, (_, i) => [
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
  assert.equal(Object.keys(result.channels).length, MAX_CHANNEL_STAR_ENTRIES);
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
  const TARGET = "aaa-target"; // lexicographically small → evicted by the id tiebreak

  // >500 entries all at the CURRENT second (NOW). With MAX+1 equal-updatedAt
  // entries, boundStarStore sorts ascending by (updatedAt, id) and keeps the
  // highest MAX, so the lowest id is evicted — TARGET, NOT because it is old.
  const channels = { [TARGET]: E(true, NOW, 7) };
  for (let i = 0; i < MAX_CHANNEL_STAR_ENTRIES; i++) {
    channels[`z-${String(i).padStart(3, "0")}`] = E(true, NOW, 0);
  }
  const bounded = boundStarStore({ version: 1, channels });
  assert.equal(
    Object.keys(bounded.channels).length,
    MAX_CHANNEL_STAR_ENTRIES,
    "bound trims to the cap",
  );
  assert.equal(
    bounded.channels[TARGET],
    undefined,
    "TARGET evicted by the id tiebreak at equal updatedAt",
  );

  // Remount in the same second: TARGET's rev high-water is gone with the entry,
  // so a fresh click mints rev 1 at updatedAt=NOW.
  const click = { version: 1, channels: { [TARGET]: E(true, NOW, 1) } };
  // The previously observed remote for TARGET at the same second, rev 100 (it
  // may precede the remount — not genuinely concurrent).
  const remote = { version: 1, channels: { [TARGET]: E(false, NOW, 100) } };

  // equal updatedAt → rev decides → 100 > 1: the click LOSES. Documented
  // deterministic residual, proven here through real eviction+remount, not a
  // pre-shrunk tuple. Deterministic in both merge orders — a lost click, never
  // a divergence.
  assert.deepEqual(
    mergeStores(click, remote).channels[TARGET],
    E(false, NOW, 100),
    "equal updatedAt → higher rev wins deterministically (documented residual)",
  );
  assert.deepEqual(
    mergeStores(remote, click).channels[TARGET],
    E(false, NOW, 100),
  );
});

// ── starredChannelIdsFromStore ────────────────────────────────────────────────

test("starredChannelIdsFromStore: returns set of IDs where starred=true", () => {
  const result = starredChannelIdsFromStore({
    version: 1,
    channels: {
      a: E(true, 100, 0),
      b: E(true, 200, 0),
      c: E(false, 300, 0),
    },
  });
  assert.deepEqual([...result].sort(), ["a", "b"]);
});

test("starredChannelIdsFromStore: all-false / empty returns empty set", () => {
  assert.equal(
    starredChannelIdsFromStore({
      version: 1,
      channels: { x: E(false, 1, 0) },
    }).size,
    0,
  );
  assert.equal(
    starredChannelIdsFromStore({ version: 1, channels: {} }).size,
    0,
  );
});
