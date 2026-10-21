//! `engine/src/traffic.ts`: volumes and running speeds, and the calibration that adjusts them.
//!
//! `Cal` is an area's calibration (`{ ...DEFAULT_CALIBRATION, ...pack.calibration }`) with each
//! edge's traffic terms worked out once (`termsOf`, which the TypeScript caches on the edge).
//! Every product and sum keeps the TypeScript's order.

use std::cell::Cell;

use crate::fxhash::FxHashMap;
use crate::graph::{Edge, Graph};
use crate::jsmath::{js_ceil, js_max, js_min, js_pow, js_rem};
use crate::pack::{self, RoadClass};

fn class_index(c: RoadClass) -> usize {
    RoadClass::ALL.iter().position(|x| *x == c).expect("a class")
}

fn peak_vph(c: RoadClass) -> f64 {
    match c {
        RoadClass::Motorway => 3600.0,
        RoadClass::Trunk => 1500.0,
        RoadClass::Primary => 950.0,
        RoadClass::Secondary => 700.0,
        RoadClass::Tertiary => 420.0,
        RoadClass::Unclassified => 160.0,
        RoadClass::Residential => 45.0,
        RoadClass::LivingStreet => 10.0,
    }
}

fn default_lanes_per_dir(c: RoadClass) -> f64 {
    match c {
        RoadClass::Motorway => 3.0,
        RoadClass::Trunk | RoadClass::Primary | RoadClass::Secondary => 2.0,
        _ => 1.0,
    }
}

fn lane_capacity(c: RoadClass) -> f64 {
    match c {
        RoadClass::Motorway => 1900.0,
        RoadClass::Trunk => 1500.0,
        RoadClass::Primary => 1100.0,
        RoadClass::Secondary => 1000.0,
        RoadClass::Tertiary => 850.0,
        RoadClass::Unclassified => 700.0,
        RoadClass::Residential => 600.0,
        RoadClass::LivingStreet => 400.0,
    }
}

/// BPR congestion curve: freeways the updated freeway fit, everything else the classic 0.15/4.
fn bpr(c: RoadClass) -> (f64, f64) {
    match c {
        RoadClass::Motorway | RoadClass::Trunk => (0.83, 5.5),
        _ => (0.15, 4.0),
    }
}

/// `WEEKDAY_PROFILE`: weekday demand as a share of the peak, by minute since midnight.
const WEEKDAY_PROFILE: [(f64, f64); 20] = [
    (0.0, 0.06),
    (300.0, 0.12),
    (360.0, 0.35),
    (405.0, 0.55),
    (420.0, 0.68),
    (435.0, 0.8),
    (450.0, 0.9),
    (465.0, 0.97),
    (475.0, 1.0),
    (495.0, 1.0),
    (510.0, 0.9),
    (540.0, 0.78),
    (600.0, 0.65),
    (720.0, 0.75),
    (900.0, 0.88),
    (1020.0, 1.0),
    (1080.0, 0.9),
    (1200.0, 0.5),
    (1320.0, 0.25),
    (1440.0, 0.06),
];

/// `demandShare` on the weekday profile. (The TypeScript flattens the profile's differences
/// ahead of time; `f1 - f0` here is the same subtraction, so the same double.)
pub fn demand_share(minute_of_day: f64) -> f64 {
    let m = js_rem(js_rem(minute_of_day, 1440.0) + 1440.0, 1440.0);
    for i in 1..WEEKDAY_PROFILE.len() {
        let (m1, f1) = WEEKDAY_PROFILE[i];
        let (m0, f0) = WEEKDAY_PROFILE[i - 1];
        if m <= m1 {
            return f0 + ((f1 - f0) * (m - m0)) / (m1 - m0);
        }
    }
    WEEKDAY_PROFILE[WEEKDAY_PROFILE.len() - 1].1
}

/// `Stretch`: factors for the edges between consecutive `nodes`, on the ways `ways` names.
#[derive(Clone, Debug, PartialEq)]
pub struct Stretch {
    pub nodes: Vec<i64>,
    pub ways: Vec<i64>,
    pub volume: f64,
    pub spread: f64,
}

/// `EdgeTerms`: what edgeVolume and runningTime read of an edge that is the same at every minute.
#[derive(Clone, Copy, Debug)]
pub struct EdgeTerms {
    pub base: f64,
    pub class_volume: f64,
    pub way_volume: f64,
    pub t0: f64,
    pub cap: f64,
    pub alpha: f64,
    pub beta: f64,
    pub stretch_volume: f64,
    pub spread: f64,
}

/// An area's calibration, resolved over the defaults, with its edges' terms.
#[derive(Clone, Debug)]
pub struct Cal {
    pub volume_scale: f64,
    pub speed_scale: f64,
    pub day_sigma: f64,
    pub edge_sigma: f64,
    pub peak_exponent: f64,
    pub left_turn_share: f64,
    class_volume: [Option<f64>; 8],
    class_speed: [Option<f64>; 8],
    way_volume: FxHashMap<String, f64>,
    /// In the calibration's property order.
    pub stretches: Vec<Stretch>,
    /// (fromNode, toNode, way) → index into `stretches`, the last stretch naming an edge winning.
    stretch_index: FxHashMap<(i64, i64, i64), usize>,
    terms: Vec<EdgeTerms>,
    /// The last minute's demand raised to the peak exponent (`edgeVolume`'s cache).
    demand: Cell<(f64, f64, f64)>,
}

/// `DEFAULT_CALIBRATION`'s scalars.
pub const DEFAULT_VOLUME_SCALE: f64 = 1.0;
pub const DEFAULT_SPEED_SCALE: f64 = 1.0;
pub const DEFAULT_DAY_SIGMA: f64 = 0.15;
pub const DEFAULT_EDGE_SIGMA: f64 = 0.1;
pub const DEFAULT_PEAK_EXPONENT: f64 = 1.0;
pub const DEFAULT_LEFT_TURN_SHARE: f64 = 0.15;

impl Cal {
    /// `{ ...DEFAULT_CALIBRATION, ...(calibration ?? {}) }`, priced for `g`'s edges.
    pub fn new(c: Option<&pack::Calibration>, g: &Graph) -> Cal {
        let d = pack::Calibration::default();
        let c = c.unwrap_or(&d);
        let by_class = |m: &Option<pack::JsObject<f64>>| {
            let mut out = [None; 8];
            if let Some(m) = m {
                for cls in RoadClass::ALL {
                    out[class_index(cls)] = m.get(cls.as_str()).copied();
                }
            }
            out
        };
        let mut way_volume = FxHashMap::default();
        if let Some(m) = &c.way_volume {
            for (k, v) in m.iter() {
                way_volume.insert(k.to_owned(), *v);
            }
        }
        let stretches: Vec<Stretch> = c
            .stretches
            .as_ref()
            .map(|m| {
                m.iter()
                    .map(|(_, s)| Stretch {
                        nodes: s.nodes.clone(),
                        ways: s.ways.clone(),
                        volume: s.volume,
                        spread: s.spread,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut stretch_index = FxHashMap::default();
        for (si, s) in stretches.iter().enumerate() {
            for i in 1..s.nodes.len() {
                // `${nodes[i-1]}>${nodes[i]}@${ways[i-1]}`: with no way there the key names
                // "undefined", which no edge matches.
                if let Some(&w) = s.ways.get(i - 1) {
                    stretch_index.insert((s.nodes[i - 1], s.nodes[i], w), si);
                }
            }
        }
        let mut cal = Cal {
            volume_scale: c.volume_scale.unwrap_or(DEFAULT_VOLUME_SCALE),
            speed_scale: c.speed_scale.unwrap_or(DEFAULT_SPEED_SCALE),
            day_sigma: c.day_sigma.unwrap_or(DEFAULT_DAY_SIGMA),
            edge_sigma: c.edge_sigma.unwrap_or(DEFAULT_EDGE_SIGMA),
            peak_exponent: c.peak_exponent.unwrap_or(DEFAULT_PEAK_EXPONENT),
            left_turn_share: c.left_turn_share.unwrap_or(DEFAULT_LEFT_TURN_SHARE),
            class_volume: by_class(&c.class_volume),
            class_speed: by_class(&c.class_speed),
            way_volume,
            stretches,
            stretch_index,
            terms: Vec::new(),
            demand: Cell::new((f64::NAN, f64::NAN, 0.0)),
        };
        cal.terms = g.edges.iter().map(|e| cal.terms_of(e)).collect();
        cal
    }

    /// `stretchOf`: the stretch an edge is on, or None.
    pub fn stretch_of(&self, e: &Edge) -> Option<&Stretch> {
        if self.stretch_index.is_empty() {
            return None;
        }
        self.stretch_index
            .get(&(e.from_node, e.to_node, e.way))
            .map(|&i| &self.stretches[i])
    }

    fn terms_of(&self, e: &Edge) -> EdgeTerms {
        let stretch = self.stretch_of(e);
        let lanes = lanes_per_direction(e);
        let lane_factor = lanes / default_lanes_per_dir(e.cls);
        let (alpha, beta) = bpr(e.cls);
        let ci = class_index(e.cls);
        EdgeTerms {
            base: peak_vph(e.cls) * (if e.link { 0.4 } else { 1.0 }) * js_min(2.0, js_max(0.5, lane_factor)),
            class_volume: self.class_volume[ci].unwrap_or(1.0),
            way_volume: if self.way_volume.is_empty() {
                1.0
            } else {
                self.way_volume.get(&e.way.to_string()).copied().unwrap_or(1.0)
            },
            t0: e.length_m / ((e.free_speed_kph * self.speed_scale * self.class_speed[ci].unwrap_or(1.0)) / 3.6),
            cap: lane_capacity(e.cls) * lanes,
            alpha,
            beta,
            stretch_volume: stretch.map_or(1.0, |s| s.volume),
            spread: stretch.map_or(1.0, |s| s.spread),
        }
    }

    #[inline]
    pub fn terms(&self, e: &Edge) -> &EdgeTerms {
        &self.terms[e.id]
    }
}

/// `lanesPerDirection`: a two-way way's `lanes` counts both directions; a one-way way's is its own.
pub fn lanes_per_direction(e: &Edge) -> f64 {
    match e.lanes {
        None => default_lanes_per_dir(e.cls),
        Some(l) => js_max(1.0, if e.oneway { l } else { js_ceil(l / 2.0) }),
    }
}

/// `edgeVolume`: directional volume on an edge at a minute of the day (veh/h), before the day's
/// multiplier.
pub fn edge_volume(e: &Edge, minute_of_day: f64, cal: &Cal) -> f64 {
    let t = cal.terms(e);
    let (last_minute, last_exponent, mut demand) = cal.demand.get();
    if minute_of_day != last_minute || cal.peak_exponent != last_exponent {
        demand = js_pow(demand_share(minute_of_day), cal.peak_exponent);
        cal.demand.set((minute_of_day, cal.peak_exponent, demand));
    }
    t.base * demand * cal.volume_scale * t.class_volume * t.way_volume * t.stretch_volume
}

/// `edgeDayFactor`: the morning's demand multiplier on one edge, raised to its stretch's spread.
#[inline]
pub fn edge_day_factor(e: &Edge, cal: &Cal, day_factor: f64) -> f64 {
    let s = cal.terms(e).spread;
    if s == 1.0 {
        day_factor
    } else {
        js_pow(day_factor, s)
    }
}

/// `freeFlowTime`: seconds to drive an edge with no traffic on it.
#[inline]
pub fn free_flow_time(e: &Edge, cal: &Cal) -> f64 {
    cal.terms(e).t0
}

/// `runningTime`: mid-block running time (s) with the BPR congestion curve.
pub fn running_time(e: &Edge, minute_of_day: f64, cal: &Cal, day_factor: f64) -> f64 {
    let t = cal.terms(e);
    let vc = (edge_volume(e, minute_of_day, cal) * edge_day_factor(e, cal, day_factor)) / t.cap;
    t.t0 * (1.0 + t.alpha * js_pow(vc, t.beta))
}
