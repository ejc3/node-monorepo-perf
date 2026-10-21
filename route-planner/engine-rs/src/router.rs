//! `engine/src/router.ts`: turn-aware, time-dependent shortest paths, the movement statistics
//! they are priced with, the lazily grown free-flow bound A* uses, and alternatives.
//!
//! The heap breaks ties as the TypeScript's does, and the free-flow bound is grown and evicted
//! in the same order, so every search settles edges in the same order.

use crate::fxhash::{FxHashMap, FxHashSet};
use crate::geo::distance;
use crate::graph::{movement_allowed, Graph};
use crate::intersection::{describe_movement, sample_delay, DelayContext, Movement, MovementControl};
use crate::jsmath::{exp, js_floor, js_max, js_min, sqrt};
use crate::random::{hash, Rng};
use crate::traffic::{free_flow_time, running_time, Cal};

#[derive(Clone, Debug, PartialEq)]
pub struct Route {
    pub edges: Vec<usize>,
    pub length_m: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeanSd {
    pub mean: f64,
    pub sd: f64,
}

const STATS_SAMPLES: usize = 48;

/// `MovementStats`: per-movement delay statistics, cached by movement and five-minute bucket,
/// and (kept beside them, as the TypeScript keeps it per graph and calibration) the free-flow
/// bounds the searches use.
#[derive(Default)]
pub struct MovementStats {
    pub moves: Moves,
    pub free_flow: FreeFlowCache,
}

/// The movements and their delay statistics.
#[derive(Default)]
pub struct Moves {
    index: FxHashMap<u64, u32>,
    movements: Vec<Movement>,
    stats: FxHashMap<(u64, u64), MeanSd>,
}

impl MovementStats {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn movement_id(&mut self, g: &Graph, in_id: usize, out_id: usize) -> usize {
        self.moves.movement_id(g, in_id, out_id)
    }

    #[inline]
    pub fn get(&self, id: usize) -> &Movement {
        self.moves.get(id)
    }

    pub fn movement(&mut self, g: &Graph, in_id: usize, out_id: usize) -> &Movement {
        self.moves.movement(g, in_id, out_id)
    }

    pub fn delay(&mut self, g: &Graph, cal: &Cal, in_id: usize, out_id: usize, minute_of_day: f64) -> MeanSd {
        self.moves.delay(g, cal, in_id, out_id, minute_of_day)
    }
}

impl Moves {
    /// The movement's index (for `get`), described the first time it is asked for.
    pub fn movement_id(&mut self, g: &Graph, in_id: usize, out_id: usize) -> usize {
        let key = (in_id as u64) * (g.edges.len() as u64) + out_id as u64;
        if let Some(&i) = self.index.get(&key) {
            return i as usize;
        }
        let i = self.movements.len();
        self.movements.push(describe_movement(g, in_id, out_id));
        self.index.insert(key, i as u32);
        i
    }

    #[inline]
    pub fn get(&self, id: usize) -> &Movement {
        &self.movements[id]
    }

    /// `movement(in, out)`.
    pub fn movement(&mut self, g: &Graph, in_id: usize, out_id: usize) -> &Movement {
        let i = self.movement_id(g, in_id, out_id);
        &self.movements[i]
    }

    /// `delay(in, out, minute)`: the movement's mean and sd over 48 draws at its bucket's middle,
    /// the same random stream for a movement at every hour.
    pub fn delay(&mut self, g: &Graph, cal: &Cal, in_id: usize, out_id: usize, minute_of_day: f64) -> MeanSd {
        let bucket = js_floor(minute_of_day / 5.0) * 5.0;
        let pair = (in_id as u64) * (g.edges.len() as u64) + out_id as u64;
        // Map keys are SameValueZero: -0 and 0 are one bucket.
        let bkey = if bucket == 0.0 { 0.0f64 } else { bucket }.to_bits();
        if let Some(s) = self.stats.get(&(pair, bkey)) {
            return *s;
        }
        let mi = self.movement_id(g, in_id, out_id);
        let m = &self.movements[mi];
        let mut r = Rng::new(hash(&format!("{in_id}>{out_id}")));
        let (mut sum, mut sum2) = (0.0, 0.0);
        for _ in 0..STATS_SAMPLES {
            let day_factor = exp(cal.day_sigma * r.normal());
            let ctx = DelayContext {
                minute_of_day: bucket + 2.5,
                day_factor,
                cal,
            };
            let d = sample_delay(g, m, &ctx, &mut r).seconds;
            sum += d;
            sum2 += d * d;
        }
        let n = STATS_SAMPLES as f64;
        let mean = sum / n;
        let s = MeanSd {
            mean,
            sd: sqrt(js_max(0.0, sum2 / n - mean * mean)),
        };
        self.stats.insert((pair, bkey), s);
        s
    }
}

/// `Heap`: a binary min-heap of (key, value), ties broken exactly as router.ts's.
#[derive(Default, Clone)]
pub struct Heap {
    k: Vec<f64>,
    v: Vec<u32>,
}

impl Heap {
    #[inline]
    pub fn len(&self) -> usize {
        self.k.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.k.is_empty()
    }

    pub fn push(&mut self, key: f64, val: usize) {
        let val = val as u32;
        let mut i = self.k.len();
        self.k.push(key);
        self.v.push(val);
        while i > 0 {
            let p = (i - 1) >> 1;
            // `if (k[p] <= key) break;`: a NaN key never breaks, as in JavaScript.
            if self.k[p] <= key {
                break;
            }
            self.k[i] = self.k[p];
            self.v[i] = self.v[p];
            i = p;
        }
        self.k[i] = key;
        self.v[i] = val;
    }

    pub fn pop(&mut self) -> (f64, usize) {
        let top = (self.k[0], self.v[0] as usize);
        let lk = self.k.pop().expect("pop on an empty heap");
        let lv = self.v.pop().expect("pop on an empty heap");
        let n = self.k.len();
        if n > 0 {
            let mut i = 0;
            loop {
                let l = 2 * i + 1;
                let r = l + 1;
                let mut m = i;
                let mut mk = lk;
                if l < n && self.k[l] < mk {
                    m = l;
                    mk = self.k[l];
                }
                if r < n && self.k[r] < mk {
                    m = r;
                }
                if m == i {
                    break;
                }
                self.k[i] = self.k[m];
                self.v[i] = self.v[m];
                i = m;
            }
            self.k[i] = lk;
            self.v[i] = lv;
        }
        top
    }
}

/// Faster than any road's free speed (40 m/s): only bounds how far the backward search goes.
const CAP_SPEED_MS: f64 = 40.0;

/// A backward search from one destination over free-flow times, grown as far as a search needs.
pub struct FreeFlow {
    to: usize,
    dist: Vec<f64>,
    done: Vec<u8>,
    open: Heap,
    reach: f64,
}

impl FreeFlow {
    /// The bound at vertex `v`: its free-flow time if the search has settled it, else how far
    /// the search has gone.
    #[inline]
    pub fn to_go(&self, v: usize) -> f64 {
        if self.done[v] != 0 {
            self.dist[v]
        } else {
            self.reach
        }
    }
}

/// The free-flow searches by destination, at most four, the oldest made dropped first.
#[derive(Default)]
pub struct FreeFlowCache {
    entries: Vec<FreeFlow>,
}

impl FreeFlowCache {
    /// `freeFlowTo(g, cal, to, from)`: the bound for a search from `from` to `to`, grown until it
    /// has passed `from` with room to spare (twice its time, and at least a minute more), or the
    /// cap a trip could take at 40 m/s four times over.
    pub fn grow(&mut self, g: &Graph, cal: &Cal, to: usize, from: usize) -> &FreeFlow {
        let at = match self.entries.iter().position(|f| f.to == to) {
            Some(i) => i,
            None => {
                let n = g.vertices.len();
                let mut f = FreeFlow {
                    to,
                    dist: vec![f64::INFINITY; n],
                    done: vec![0; n],
                    open: Heap::default(),
                    reach: 0.0,
                };
                f.dist[to] = 0.0;
                f.open.push(0.0, to);
                if self.entries.len() >= 4 {
                    self.entries.remove(0);
                }
                self.entries.push(f);
                self.entries.len() - 1
            }
        };
        let f = &mut self.entries[at];
        let cap = (4.0 * distance(g.vertices[from].ll(), g.vertices[to].ll())) / CAP_SPEED_MS + 600.0;
        loop {
            if f.open.is_empty() {
                break;
            }
            let enough = js_min(
                cap,
                if f.done[from] != 0 {
                    js_max(2.0 * f.dist[from], f.dist[from] + 60.0)
                } else {
                    f64::INFINITY
                },
            );
            let short = f.reach < enough;
            if !short {
                break;
            }
            let (d, v) = f.open.pop();
            if f.done[v] != 0 {
                continue;
            }
            f.done[v] = 1;
            f.reach = d;
            for &ei in &g.vertices[v].inc {
                let e = &g.edges[ei];
                let nd = d + free_flow_time(e, cal);
                if nd < f.dist[e.from] {
                    f.dist[e.from] = nd;
                    f.open.push(nd, e.from);
                }
            }
        }
        // Searched out: every vertex left is one that cannot reach `to` at all.
        if f.open.is_empty() {
            f.reach = f64::INFINITY;
        }
        &self.entries[at]
    }
}

fn beaten_cost(c: MovementControl) -> f64 {
    match c {
        MovementControl::Signal => 15.0,
        MovementControl::AllWayStop => 8.0,
        MovementControl::Stop => 6.0,
        MovementControl::GiveWay => 2.0,
        _ => 0.0,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pricing {
    Model,
    /// Intersections priced the way a typical router does, flat and with no queues.
    Beaten,
}

#[derive(Clone, Copy)]
pub struct SearchOptions<'a> {
    pub depart_minute: f64,
    /// 0: minimise expected time. Higher: also avoid intersections whose bad days are bad.
    pub risk: f64,
    pub pricing: Pricing,
    /// Multiplies the cost of using an edge, by edge id (alternatives); None is 1 everywhere.
    pub penalty: Option<&'a [f64]>,
    /// The edge the car is already on (a new route mid-drive).
    pub start_edge: Option<usize>,
}

impl SearchOptions<'_> {
    pub fn new(depart_minute: f64, risk: f64) -> Self {
        SearchOptions {
            depart_minute,
            risk,
            pricing: Pricing::Model,
            penalty: None,
            start_edge: None,
        }
    }
}

/// `shortestPath`: fastest path from vertex `from` to vertex `to` leaving at `depart_minute`.
pub fn shortest_path(
    g: &Graph,
    cal: &Cal,
    stats: &mut MovementStats,
    from: usize,
    to: usize,
    o: &SearchOptions,
) -> Option<Route> {
    if from == to && o.start_edge.is_none() {
        return Some(Route {
            edges: Vec::new(),
            length_m: 0.0,
        });
    }
    let n = g.edges.len();
    let mut cost = vec![f64::INFINITY; n];
    let mut clock = vec![0.0f64; n]; // seconds after departure on arrival at the edge's end
    let mut prev = vec![-1i32; n];
    let mut open = Heap::default();
    let target = &g.vertices[to];
    // access=destination ways are free to use only when the trip starts or ends on them.
    let mut end_ways: FxHashSet<i64> = FxHashSet::default();
    {
        let fv = &g.vertices[from];
        for &ei in fv.out.iter().chain(&fv.inc).chain(&target.inc).chain(&target.out) {
            end_ways.insert(g.edges[ei].way);
        }
    }
    let edge_cost = |ei: usize, t: f64| -> (f64, f64) {
        let e = &g.edges[ei];
        let run = running_time(e, o.depart_minute + t / 60.0, cal, 1.0);
        let dest_penalty = if e.destination_only && !end_ways.contains(&e.way) {
            120.0
        } else {
            0.0
        };
        let p = o.penalty.map_or(1.0, |p| p[ei]);
        (run, run * p + dest_penalty)
    };
    // A* on the free-flow time still to go.
    let MovementStats { moves, free_flow } = stats;
    let to_go = free_flow.grow(g, cal, to, from);
    let h = |ei: usize| to_go.to_go(g.edges[ei].to);
    let single;
    let starts: &[usize] = match o.start_edge {
        Some(s) => {
            single = [s];
            &single
        }
        None => &g.vertices[from].out,
    };
    for &ei in starts {
        let (run, weighted) = edge_cost(ei, 0.0);
        cost[ei] = weighted;
        clock[ei] = run;
        open.push(weighted + h(ei), ei);
    }
    let mut best: isize = -1;
    let mut done = vec![0u8; n];
    while !open.is_empty() {
        let (_, ei) = open.pop();
        if done[ei] != 0 {
            continue;
        }
        done[ei] = 1;
        let e = &g.edges[ei];
        if e.to == to {
            best = ei as isize;
            break;
        }
        let outs = &g.vertices[e.to].out;
        for &fi in outs {
            if done[fi] != 0 {
                continue;
            }
            let f = &g.edges[fi];
            if !movement_allowed(g, e, f) {
                continue;
            }
            let t_arrive = clock[ei];
            let (delay, weighted_delay) = if o.pricing == Pricing::Beaten {
                let m = moves.movement(g, ei, fi);
                let d = if m.control == MovementControl::Internal {
                    0.0
                } else {
                    beaten_cost(m.control)
                };
                (d, d)
            } else {
                let d = moves.delay(g, cal, ei, fi, o.depart_minute + t_arrive / 60.0);
                (d.mean, d.mean + o.risk * d.sd)
            };
            let (run, weighted) = edge_cost(fi, t_arrive + delay);
            let nc = cost[ei] + weighted_delay + weighted;
            if nc < cost[fi] {
                cost[fi] = nc;
                clock[fi] = t_arrive + delay + run;
                prev[fi] = ei as i32;
                open.push(nc + h(fi), fi);
            }
        }
    }
    if best < 0 {
        return None;
    }
    let mut edges = Vec::new();
    let mut ei = best as i32;
    while ei >= 0 {
        edges.push(ei as usize);
        ei = prev[ei as usize];
    }
    edges.reverse();
    let mut length_m = 0.0;
    for &ei in &edges {
        length_m += g.edges[ei].length_m;
    }
    Some(Route { edges, length_m })
}

/// `overlap`: how much of `a`'s length is shared with `b` (by way and from-vertex).
pub fn overlap(g: &Graph, a: &Route, b: &Route) -> f64 {
    let in_b: FxHashSet<(i64, usize)> = b.edges.iter().map(|&ei| (g.edges[ei].way, g.edges[ei].from)).collect();
    let mut shared = 0.0;
    for &ei in &a.edges {
        let e = &g.edges[ei];
        if in_b.contains(&(e.way, e.from)) {
            shared += e.length_m;
        }
    }
    // `a.lengthM ? shared / a.lengthM : 0`
    if a.length_m != 0.0 && !a.length_m.is_nan() {
        shared / a.length_m
    } else {
        0.0
    }
}

/// `alternatives`: up to `k` genuinely different routes: route, make the edges used dearer,
/// route again, keep a path only if it shares less than `max_overlap` with each one kept.
#[allow(clippy::too_many_arguments)] // the TypeScript's signature, with the graph's parts passed in
pub fn alternatives(
    g: &Graph,
    cal: &Cal,
    stats: &mut MovementStats,
    from: usize,
    to: usize,
    o: &SearchOptions,
    k: usize,
    max_overlap: f64,
) -> Vec<Route> {
    let mut kept: Vec<Route> = Vec::new();
    let mut penalty = vec![1.0f64; g.edges.len()];
    let mut attempt = 0;
    while attempt < k * 3 && kept.len() < k {
        let r = {
            let so = SearchOptions {
                penalty: Some(&penalty),
                ..*o
            };
            shortest_path(g, cal, stats, from, to, &so)
        };
        let Some(r) = r else { break };
        if r.edges.is_empty() {
            return vec![r]; // already there: there is no other way
        }
        let distinct = kept
            .iter()
            .all(|x| overlap(g, &r, x) < max_overlap && overlap(g, x, &r) < max_overlap);
        for &ei in &r.edges {
            penalty[ei] *= 1.35;
        }
        if distinct {
            kept.push(r);
        }
        attempt += 1;
    }
    kept
}
