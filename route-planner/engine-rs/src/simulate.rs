//! `engine/src/simulate.ts`: Monte Carlo of one route over many mornings, and what made it wide.

use std::cmp::Ordering;

use crate::fxhash::FxHashMap;
use crate::graph::Graph;
use crate::intersection::{explain_control, name_control, sample_delay, DelayContext, MovementControl};
use crate::jsmath::{exp, js_max, js_min, js_round};
use crate::random::Rng;
use crate::router::{MovementStats, Route};
use crate::traffic::{running_time, Cal};

#[derive(Clone, Copy, Debug)]
pub struct SimOptions {
    pub runs: usize,
    pub seed: f64,
    /// Fixed time at the ends (seconds).
    pub end_overhead_sec: f64,
}

impl SimOptions {
    pub fn new(runs: usize, seed: f64) -> Self {
        SimOptions {
            runs,
            seed,
            end_overhead_sec: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Hotspot {
    pub complex: usize,
    pub lat: f64,
    pub lon: f64,
    pub what: String,
    pub name: String,
    pub control: MovementControl,
    pub inferred: bool,
    pub mean_sec: f64,
    pub p50_sec: f64,
    pub p90_sec: f64,
    pub overflow_share: f64,
}

#[derive(Clone, Debug)]
pub struct SimResult {
    pub depart_minute: f64,
    /// Door-to-door seconds, sorted ascending.
    pub samples: Vec<f64>,
    pub mean_sec: f64,
    pub p10_sec: f64,
    pub p50_sec: f64,
    pub p90_sec: f64,
    pub p95_sec: f64,
    pub running_mean_sec: f64,
    pub junction_mean_sec: f64,
    pub hotspots: Vec<Hotspot>,
}

/// A Float64Array's `sort()`: ascending, -0 before +0, and every NaN last. (`total_cmp` alone
/// puts a NaN with its sign bit set first, and a NaN's sign from arithmetic is the hardware's:
/// x86 makes negative ones, arm64 positive ones.)
pub fn sort_f64(xs: &mut [f64]) {
    xs.sort_unstable_by(|a, b| match (a.is_nan(), b.is_nan()) {
        (false, false) => a.total_cmp(b),
        (x, y) => x.cmp(&y),
    });
}

/// `[...xs].sort((a, b) => a - b)`: a stable sort that keeps -0 and +0 (and anything the
/// comparator calls equal) in their order.
pub fn sort_numbers(xs: &mut [f64]) {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
}

/// `quantile(sorted, q)`: the sample at round(q · (n − 1)); NaN for none.
pub fn quantile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let last = (sorted.len() - 1) as f64;
    let i = js_min(last, js_max(0.0, js_round(q * last)));
    sorted[i as usize]
}

/// One simulated morning: `enter[i]` and `leave[i]` the seconds after departure at which the car
/// starts edge i and reaches its end; `wait[i]` its wait at the junction after it.
#[derive(Clone, Debug)]
pub struct Morning {
    pub enter: Vec<f64>,
    pub leave: Vec<f64>,
    pub wait: Vec<f64>,
    pub overflow: Vec<u8>,
    pub total_sec: f64,
}

/// `simulateMornings`: `runs` mornings of a route leaving at `depart_minute`, and the ids (in
/// `stats`) of its movements.
pub fn simulate_mornings(
    g: &Graph,
    cal: &Cal,
    stats: &mut MovementStats,
    route: &Route,
    depart_minute: f64,
    o: &SimOptions,
) -> (Vec<Morning>, Vec<usize>) {
    let mut r = Rng::from_js_number(o.seed);
    let mut movements = Vec::with_capacity(route.edges.len().saturating_sub(1));
    for i in 1..route.edges.len() {
        movements.push(stats.movement_id(g, route.edges[i - 1], route.edges[i]));
    }
    let n = route.edges.len();
    let mut mornings = Vec::with_capacity(o.runs);
    for _ in 0..o.runs {
        // One morning: everyone's demand moves together.
        let day_factor = exp(cal.day_sigma * r.normal());
        let mut m = Morning {
            enter: vec![0.0; n],
            leave: vec![0.0; n],
            wait: vec![0.0; n],
            overflow: vec![0; n],
            total_sec: 0.0,
        };
        let mut t = 0.0;
        for i in 0..n {
            let e = &g.edges[route.edges[i]];
            m.enter[i] = t;
            t += running_time(e, depart_minute + t / 60.0, cal, day_factor) * exp(cal.edge_sigma * r.normal());
            m.leave[i] = t;
            if i < movements.len() {
                let ctx = DelayContext {
                    minute_of_day: depart_minute + t / 60.0,
                    day_factor,
                    cal,
                };
                let d = sample_delay(g, stats.get(movements[i]), &ctx, &mut r);
                m.wait[i] = d.seconds;
                m.overflow[i] = u8::from(d.overflow);
                t += d.seconds;
            }
        }
        m.total_sec = t + o.end_overhead_sec;
        mornings.push(m);
    }
    (mornings, movements)
}

/// Left to right, as reduce adds.
fn sum(xs: &[f64]) -> f64 {
    let mut s = 0.0;
    for x in xs {
        s += x;
    }
    s
}

/// `simulateRoute`: a route's mornings summed up, with (when `hotspots`) where the waits are.
pub fn simulate_route(
    g: &Graph,
    cal: &Cal,
    stats: &mut MovementStats,
    route: &Route,
    depart_minute: f64,
    o: &SimOptions,
    hotspots: bool,
) -> SimResult {
    let (mornings, movements) = simulate_mornings(g, cal, stats, route, depart_minute, o);
    let mut samples: Vec<f64> = mornings.iter().map(|m| m.total_sec).collect();
    let (mut run_sum, mut junc_sum) = (0.0, 0.0);
    for m in &mornings {
        for i in 0..m.enter.len() {
            run_sum += m.leave[i] - m.enter[i];
            junc_sum += m.wait[i];
        }
    }
    sort_f64(&mut samples);
    let runs = o.runs as f64;
    let mut out = SimResult {
        depart_minute,
        mean_sec: sum(&samples) / runs,
        p10_sec: quantile(&samples, 0.1),
        p50_sec: quantile(&samples, 0.5),
        p90_sec: quantile(&samples, 0.9),
        p95_sec: quantile(&samples, 0.95),
        running_mean_sec: run_sum / runs,
        junction_mean_sec: junc_sum / runs,
        samples,
        hotspots: Vec::new(),
    };
    if !hotspots {
        return out;
    }
    // Hotspots: per intersection complex, the movements on this route through it summed, in the
    // order the route first meets each complex.
    struct Spot {
        m: usize,
        sums: Vec<f64>,
        over: f64,
    }
    let mut by_complex: Vec<Spot> = Vec::new();
    let mut at: FxHashMap<usize, usize> = FxHashMap::default();
    for (i, &mi) in movements.iter().enumerate() {
        let m = stats.get(mi);
        if m.control == MovementControl::None {
            continue;
        }
        let mut over = 0.0;
        for mo in &mornings {
            over += f64::from(mo.overflow[i]);
        }
        let si = *at.entry(m.complex).or_insert_with(|| {
            by_complex.push(Spot {
                m: mi,
                sums: vec![0.0; o.runs],
                over: 0.0,
            });
            by_complex.len() - 1
        });
        let h = &mut by_complex[si];
        if m.control != MovementControl::Internal {
            h.m = mi;
        }
        for (k, mo) in mornings.iter().enumerate().take(o.runs) {
            h.sums[k] += mo.wait[i];
        }
        h.over = js_max(h.over, over);
    }
    let mut spots: Vec<Hotspot> = by_complex
        .into_iter()
        .map(|Spot { m, sums, over }| {
            let m = stats.get(m);
            let mut sorted = sums;
            sort_f64(&mut sorted);
            let v = &g.vertices[g.edges[m.in_edge].to];
            Hotspot {
                complex: m.complex,
                lat: v.lat,
                lon: v.lon,
                what: explain_control(m),
                name: name_control(m),
                control: m.control,
                inferred: m.inferred,
                mean_sec: sum(&sorted) / runs,
                p50_sec: quantile(&sorted, 0.5),
                p90_sec: quantile(&sorted, 0.9),
                overflow_share: over / runs,
            }
        })
        .collect();
    spots.sort_by(|a, b| b.mean_sec.partial_cmp(&a.mean_sec).unwrap_or(Ordering::Equal));
    out.hotspots = spots;
    out
}

/// `onTimeShare`: share of simulated mornings that arrive at or before `arrive_by_minute`.
pub fn on_time_share(sim: &SimResult, arrive_by_minute: f64) -> f64 {
    let budget = (arrive_by_minute - sim.depart_minute) * 60.0;
    let (mut lo, mut hi) = (0usize, sim.samples.len());
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if sim.samples[mid] <= budget {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo as f64 / sim.samples.len() as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_float64array_sort_puts_every_nan_last_whatever_its_sign() {
        let negative_nan = f64::from_bits(0xfff8_0000_0000_0000);
        let mut xs = [3.0, negative_nan, -0.0, f64::NEG_INFINITY, f64::NAN, 0.0, -1.0];
        sort_f64(&mut xs);
        let head: Vec<u64> = xs[..5].iter().map(|x| x.to_bits()).collect();
        let want: Vec<u64> = [f64::NEG_INFINITY, -1.0, -0.0, 0.0, 3.0]
            .iter()
            .map(|x| x.to_bits())
            .collect();
        assert_eq!(head, want);
        assert!(xs[5].is_nan() && xs[6].is_nan());
    }
}
