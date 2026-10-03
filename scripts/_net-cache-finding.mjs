// The claim text for bench/ci-cache-network-bench.json, derived from the measured
// cells. ci-cache-network-bench.mjs writes `netCacheFinding()` into the record's
// `finding` field and net-cache-chart.mjs builds its headline from
// `netCacheSummary()`, so neither can state a speedup or a network cost the cells
// do not carry (a hard-coded sentence outlives the box and toolchain it was written
// on). Pure: reads only the record object; a missing field throws.

const need = (v, what) => {
  if (v === undefined || v === null)
    throw new Error(`ci-cache-network-bench record missing ${what}`);
  return v;
};

// Always MB, matching the bench log; >=10 MB rounds to integer, sub-MB keeps one decimal.
export const cacheMB = (bytes) => `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`;

// Per task: the localhost floor, the range its own samples span, and each shaped
// profile's restore time against that floor. A shaped restore that lands INSIDE the
// floor's observed [min, max] sample range is `withinSpread` — it is not reported as
// a network cost (or a network saving). A floor with fewer than two samples has no
// observed range, so nothing is `withinSpread` and every delta is reported as-is
// (`spreadKnown: false`).
export function netCacheSummary(rec) {
  const profiles = need(rec.profiles, "profiles");
  const floorProfile = need(
    profiles.find((p) => p.rttMs === 0 && !p.rate),
    "an unshaped (rttMs 0, no rate) floor profile",
  );
  const shaped = profiles.filter((p) => p !== floorProfile);
  if (!shaped.length) throw new Error("ci-cache-network-bench record has no shaped profile");
  for (const p of shaped)
    if (!Number.isFinite(p.rttMs))
      throw new Error(`ci-cache-network-bench record: profile ${p.name} has no numeric rttMs`);
  const speedups = [];
  const tasks = Object.entries(need(rec.results, "results")).map(([task, r]) => {
    const coldMs = need(r.coldNoRemoteMs, `${task}.coldNoRemoteMs`);
    const cell = (name) => need(need(r.profiles, `${task}.profiles`)[name], `${task}.${name}`);
    const floor = cell(floorProfile.name);
    const floorMs = need(floor.restoreMs, `${task}.${floorProfile.name}.restoreMs`);
    const floorSamples = need(floor.restoreSamples, `${task}.${floorProfile.name}.restoreSamples`);
    const floorMin = Math.min(...floorSamples);
    const floorMax = Math.max(...floorSamples);
    const spreadKnown = floorSamples.length >= 2;
    for (const p of profiles)
      speedups.push(coldMs / need(cell(p.name).restoreMs, `${task}.${p.name}.restoreMs`));
    return {
      task,
      cacheBytes: need(r.bytesTransferred, `${task}.bytesTransferred`),
      coldMs,
      floorMs,
      floorMin,
      floorMax,
      spreadKnown,
      shaped: shaped.map((p) => {
        const restoreMs = cell(p.name).restoreMs;
        return {
          name: p.name,
          deltaMs: restoreMs - floorMs,
          withinSpread: spreadKnown && restoreMs >= floorMin && restoreMs <= floorMax,
        };
      }),
    };
  });
  return {
    floorName: floorProfile.name,
    // the shaped profile with the largest configured RTT (a property of the shaping,
    // not a claim about which restore measured slowest)
    farthest: shaped.reduce((a, b) => (b.rttMs > a.rttMs ? b : a)),
    spreadKnown: tasks.every((t) => t.spreadKnown),
    minSpeedup: Math.min(...speedups),
    maxSpeedup: Math.max(...speedups),
    tasks,
  };
}

// a delta that rounds to 0.0s gets no direction (`roundsToZero`): it reads as
// "no measured difference", never "+0.0s"
export const roundsToZero = (ms) => (Math.abs(ms) / 1000).toFixed(1) === "0.0";
const signedSecs = (ms) =>
  roundsToZero(ms)
    ? "no measured difference"
    : `${ms < 0 ? "−" : "+"}${(Math.abs(ms) / 1000).toFixed(1)}s`;
export const speedupRange = (s) => `${s.minSpeedup.toFixed(1)}–${s.maxSpeedup.toFixed(1)}×`;

export function netCacheFinding(rec) {
  const s = netCacheSummary(rec);
  const perTask = s.tasks
    .map(
      (t) =>
        `${t.task} (${cacheMB(t.cacheBytes)} cache): ` +
        t.shaped
          .map(
            (p) =>
              `${p.name} ${p.withinSpread ? "within the floor's sample spread" : signedSecs(p.deltaMs)}`,
          )
          .join(", "),
    )
    .join("; ");
  // a restore slower than recomputing is a measured outcome, not a reason to lose the
  // run: the sentence states the ratio either way and only says "faster" when every
  // cell is
  const lead =
    s.minSpeedup > 1
      ? `A shared remote cache restores a fresh CI runner ${speedupRange(s)} faster than cold compute`
      : `The cold-compute ÷ remote-restore ratio spans ${speedupRange(s)} (under 1× the restore is slower than recomputing)`;
  return (
    `${lead} across the links measured (${need(rec.env?.cores, "env.cores")} cores, scale ` +
    `${need(rec.scale, "scale")}). Restore time against the ${s.floorName} floor, per task — ${perTask}.` +
    (s.spreadKnown
      ? ` A shaped restore inside the range of the floor's own samples is reported as within spread, not ` +
        `as a network cost.`
      : ` The floor has a single sample for at least one task, so its run-to-run range is unknown and ` +
        `that task's deltas are not separated from it.`)
  );
}
