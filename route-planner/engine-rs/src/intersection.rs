//! `engine/src/intersection.ts`: the delay one vehicle meets making one movement (in-edge to
//! out-edge) at one junction. `sample_delay` draws from the generator in exactly the
//! TypeScript's order, so one seed gives one outcome in both engines.

use crate::geo::turn_angle;
use crate::graph::{edge_rank, Edge, Graph};
use crate::jsmath::{abs, exp, expm1, js_max, js_min, js_round};
use crate::pack::Control;
use crate::random::Rng;
use crate::text::short;
use crate::traffic::{edge_day_factor, edge_volume, lanes_per_direction, Cal};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Turn {
    Straight,
    Right,
    Left,
    Uturn,
}

impl Turn {
    pub fn as_str(self) -> &'static str {
        match self {
            Turn::Straight => "straight",
            Turn::Right => "right",
            Turn::Left => "left",
            Turn::Uturn => "uturn",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MovementControl {
    Signal,
    AllWayStop,
    Stop,
    GiveWay,
    MajorLeft,
    Free,
    Internal,
    None,
}

impl MovementControl {
    pub fn as_str(self) -> &'static str {
        match self {
            MovementControl::Signal => "signal",
            MovementControl::AllWayStop => "all_way_stop",
            MovementControl::Stop => "stop",
            MovementControl::GiveWay => "give_way",
            MovementControl::MajorLeft => "major_left",
            MovementControl::Free => "free",
            MovementControl::Internal => "internal",
            MovementControl::None => "none",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Approach {
    pub edge: usize,
    pub major: bool,
}

#[derive(Clone, Debug)]
pub struct Movement {
    pub in_edge: usize,
    pub out_edge: usize,
    pub complex: usize,
    pub turn: Turn,
    pub control: MovementControl,
    pub inferred: bool,
    /// Approaches into the intersection from outside it.
    pub approaches: Vec<Approach>,
    /// The road crossed or joined, for explanations.
    pub cross_name: String,
    pub major_lanes: f64,
}

pub fn turn_of(in_edge: &Edge, out_edge: &Edge) -> Turn {
    let a = turn_angle(in_edge.end_bearing, out_edge.start_bearing);
    if abs(a) > 150.0 {
        Turn::Uturn
    } else if a > 40.0 {
        Turn::Right
    } else if a < -40.0 {
        Turn::Left
    } else {
        Turn::Straight
    }
}

pub fn describe_movement(g: &Graph, in_id: usize, out_id: usize) -> Movement {
    let (in_edge, out_edge) = (&g.edges[in_id], &g.edges[out_id]);
    let v = &g.vertices[in_edge.to];
    let cx = &g.complexes[v.complex];
    let internal = g.vertices[in_edge.from].complex == v.complex;
    let mut approaches = Vec::new();
    for &vi in &cx.vertices {
        for &ei in &g.vertices[vi].inc {
            let e = &g.edges[ei];
            if g.vertices[e.from].complex == v.complex {
                continue;
            }
            approaches.push(Approach {
                edge: ei,
                major: edge_rank(e) >= cx.major_rank - 0.5,
            });
        }
    }
    let turn = turn_of(in_edge, out_edge);
    let major_approach = approaches.iter().find(|a| a.major);
    let cross_name = if out_edge.name != in_edge.name && !out_edge.name.is_empty() {
        out_edge.name.clone()
    } else {
        cx.major_name.clone()
    };
    let major_lanes = major_approach.map_or(1.0, |a| lanes_per_direction(&g.edges[a.edge]));
    let control = if v.degree < 3 {
        MovementControl::None
    } else if internal {
        MovementControl::Internal
    } else {
        match in_edge.control {
            Some(Control::Signal) => MovementControl::Signal,
            Some(Control::AllWayStop) => MovementControl::AllWayStop,
            Some(Control::Stop) => MovementControl::Stop,
            Some(Control::GiveWay | Control::MiniRoundabout) => MovementControl::GiveWay,
            None if turn == Turn::Left && edge_rank(in_edge) >= cx.major_rank - 0.5 && approaches.len() > 2 => {
                MovementControl::MajorLeft
            }
            None => MovementControl::Free,
        }
    };
    Movement {
        in_edge: in_id,
        out_edge: out_id,
        complex: v.complex,
        turn,
        control,
        inferred: in_edge.control_inferred,
        approaches,
        cross_name,
        major_lanes,
    }
}

#[derive(Clone, Copy)]
enum GapKind {
    Right,
    Straight,
    Left,
}

/// HCM-style critical headway (tc) and follow-up time (tf), seconds.
fn gap(kind: GapKind) -> (f64, f64) {
    match kind {
        GapKind::Right => (6.2, 3.3),
        GapKind::Straight => (6.5, 4.0),
        GapKind::Left => (7.1, 3.5),
    }
}

/// `gapCapacity`: capacity of a gap-accepting movement against conflicting flow `vc` (veh/h).
pub fn gap_capacity(vc: f64, tc: f64, tf: f64) -> f64 {
    if vc < 1e-6 {
        return 3600.0 / tf;
    }
    let q = vc / 3600.0;
    (vc * exp(-q * tc)) / -expm1(-q * tf)
}

/// `sampleGapWait`: time until the first gap of at least `tc` seconds in a Poisson stream.
fn sample_gap_wait(vph: f64, tc: f64, rng: &mut Rng) -> f64 {
    if vph < 1.0 {
        return 0.0;
    }
    let rate = vph / 3600.0;
    let mut t = 0.0;
    for _ in 0..400 {
        let gap = rng.exponential(rate);
        if gap >= tc {
            return t;
        }
        t += gap;
    }
    t
}

#[derive(Clone, Copy)]
pub struct DelayContext<'a> {
    pub minute_of_day: f64,
    pub day_factor: f64,
    pub cal: &'a Cal,
}

#[derive(Clone, Copy, Debug)]
pub struct MovementFlows {
    pub conflict: f64,
    pub approach: f64,
    pub total: f64,
}

pub fn flows(g: &Graph, m: &Movement, ctx: &DelayContext) -> MovementFlows {
    let (minute, cal, df) = (ctx.minute_of_day, ctx.cal, ctx.day_factor);
    let in_edge = &g.edges[m.in_edge];
    let own = edge_volume(in_edge, minute, cal) * edge_day_factor(in_edge, cal, df);
    let (mut major_others, mut total) = (0.0, 0.0);
    for a in &m.approaches {
        let ae = &g.edges[a.edge];
        let v = edge_volume(ae, minute, cal) * edge_day_factor(ae, cal, df);
        total += v;
        if a.major && a.edge != m.in_edge {
            major_others += v;
        }
    }
    let conflict = if m.control == MovementControl::MajorLeft {
        major_others
    } else if m.turn == Turn::Right {
        major_others * 0.5
    } else {
        major_others
    };
    MovementFlows {
        conflict,
        approach: own,
        total,
    }
}

/// No movement is priced above this.
pub const MAX_MOVEMENT_DELAY_S: f64 = 900.0;
const MIN_CAPACITY_VPH: f64 = 60.0;
const STOP_LOSS: f64 = 5.0;

fn turn_loss(t: Turn) -> f64 {
    match t {
        Turn::Straight => 0.0,
        Turn::Right => 2.5,
        Turn::Left => 3.5,
        Turn::Uturn => 12.0,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DelaySample {
    pub seconds: f64,
    /// Demand above capacity: a queue that grows for as long as the peak lasts.
    pub overflow: bool,
}

/// `sampleQueue`: cars queued ahead on an approach with utilisation rho.
fn sample_queue(rho: f64, capacity_vph: f64, rng: &mut Rng) -> (f64, bool) {
    let r = js_min(rho, 0.95);
    let n = rng.geometric(r);
    if rho <= 0.95 {
        return (n, false);
    }
    let extra = ((rho - 0.95) * capacity_vph * rng.uniform(0.0, 1200.0)) / 3600.0;
    (n + js_round(extra), true)
}

pub fn sample_delay(g: &Graph, m: &Movement, ctx: &DelayContext, rng: &mut Rng) -> DelaySample {
    let tl = turn_loss(m.turn);
    match m.control {
        MovementControl::None | MovementControl::Internal => DelaySample {
            seconds: tl,
            overflow: false,
        },
        MovementControl::Free => DelaySample {
            seconds: tl + if m.turn == Turn::Straight { 0.0 } else { 0.5 },
            overflow: false,
        },
        MovementControl::MajorLeft => {
            let f = flows(g, m, ctx);
            let wait = sample_gap_wait(f.conflict, 4.1, rng);
            DelaySample {
                seconds: tl + wait + if wait > 0.0 { 2.0 } else { 0.0 },
                overflow: false,
            }
        }
        MovementControl::Stop | MovementControl::GiveWay => {
            let f = flows(g, m, ctx);
            let kind = match m.turn {
                Turn::Right => GapKind::Right,
                Turn::Straight => GapKind::Straight,
                _ => GapKind::Left,
            };
            // A four-lane major road makes a left or crossing harder (HCM adds to tc).
            let wide = if m.major_lanes >= 2.0 && !matches!(kind, GapKind::Right) {
                0.7
            } else {
                0.0
            };
            let yield_only = m.control == MovementControl::GiveWay;
            let (gtc, tf) = gap(kind);
            let tc = gtc + wide - if yield_only { 0.8 } else { 0.0 };
            let cap = js_max(MIN_CAPACITY_VPH, gap_capacity(f.conflict, tc, tf));
            let (n, overflow) = sample_queue(f.approach / cap, cap, rng);
            let mut t = 0.0;
            let mut i = 0.0;
            while i < n {
                t += rng.exponential(cap / 3600.0);
                i += 1.0;
            }
            t += sample_gap_wait(f.conflict, tc, rng);
            t += if yield_only && t < 1.0 { 1.5 } else { STOP_LOSS };
            DelaySample {
                seconds: js_min(MAX_MOVEMENT_DELAY_S, t + tl),
                overflow,
            }
        }
        MovementControl::AllWayStop => {
            let f = flows(g, m, ctx);
            // Vehicles take turns: about 4 s each when every approach is busy, quicker when not.
            let h_sat = 4.0
                + match m.turn {
                    Turn::Left => 0.4,
                    Turn::Right => -0.4,
                    _ => 0.0,
                };
            let rho_all = (f.total * h_sat) / 3600.0;
            let cap = 3600.0 / h_sat / js_max(1.0, m.approaches.len() as f64 / 2.0);
            let (n, overflow) = sample_queue(js_max(rho_all, f.approach / cap), cap, rng);
            let mut t = STOP_LOSS;
            let mut i = 0.0;
            while i < n {
                t += rng.uniform(0.6, 1.4) * h_sat * js_min(2.0, 1.0 + rho_all);
                i += 1.0;
            }
            // Waiting your turn against a car already at another approach.
            if rng.next() < js_min(0.9, rho_all) {
                t += rng.uniform(1.0, h_sat);
            }
            DelaySample {
                seconds: js_min(MAX_MOVEMENT_DELAY_S, t + tl),
                overflow,
            }
        }
        MovementControl::Signal => {
            let f = flows(g, m, ctx);
            let cx = &g.complexes[m.complex];
            let cycle = if cx.major_rank >= 5.0 {
                130.0
            } else if cx.major_rank >= 4.0 {
                110.0
            } else if cx.major_rank >= 3.0 {
                90.0
            } else {
                70.0
            };
            let on_major = m
                .approaches
                .iter()
                .find(|a| a.edge == m.in_edge)
                .is_some_and(|a| a.major);
            let left = m.turn == Turn::Left;
            let mut g_share = if on_major { 0.55 } else { 0.3 };
            if left {
                g_share = if on_major { 0.14 } else { 0.12 }; // a protected left phase
            }
            let green = g_share * cycle;
            let red = cycle - green;
            let lanes = if left {
                1.0
            } else {
                lanes_per_direction(&g.edges[m.in_edge])
            };
            let demand = f.approach
                * if left {
                    ctx.cal.left_turn_share
                } else {
                    1.0 - ctx.cal.left_turn_share
                };
            let x = demand / (1800.0 * lanes * g_share);
            // Coordinated arterials: a through driver on the major road often arrives in green.
            let progressed = on_major && m.turn == Turn::Straight && rng.next() < 0.3;
            let arrival = if progressed {
                rng.uniform(0.0, green)
            } else {
                rng.uniform(0.0, cycle)
            };
            let mut t = 0.0;
            if arrival >= green {
                let wait_red = cycle - arrival;
                // Cars that arrived during the red discharge first, ~2 s each per lane.
                let ahead = (demand / lanes / 3600.0) * (arrival - green);
                t = wait_red + 2.0 * ahead + 2.0 + STOP_LOSS;
            }
            // Near and over saturation the queue does not clear in one green: sometimes miss a cycle.
            let miss_p = js_max(0.0, js_min(0.9, (x - 0.8) / 0.4));
            let mut overflow = false;
            while rng.next() < miss_p && t < cycle * 4.0 {
                t += red + if t == 0.0 { STOP_LOSS } else { 0.0 };
                overflow = x > 1.0;
            }
            DelaySample {
                seconds: t + tl,
                overflow,
            }
        }
    }
}

/// `nameControl`: a hotspot's name in a few words, "Stop at Oak Ave (left)".
pub fn name_control(m: &Movement) -> String {
    let at = short(if m.cross_name.is_empty() {
        "cross street"
    } else {
        &m.cross_name
    });
    let turn = if m.turn == Turn::Left { " (left)" } else { "" };
    match m.control {
        MovementControl::Signal => format!("Signal at {at}{turn}"),
        MovementControl::AllWayStop => format!("All-way stop at {at}"),
        MovementControl::Stop => format!("Stop at {at}{turn}"),
        MovementControl::GiveWay => format!("Yield at {at}"),
        MovementControl::MajorLeft => format!("Left onto {at}"),
        _ => {
            if m.turn == Turn::Straight {
                at
            } else {
                format!("{} onto {at}", if m.turn == Turn::Left { "Left" } else { "Right" })
            }
        }
    }
}

/// `explainControl`.
pub fn explain_control(m: &Movement) -> String {
    let cross = if m.cross_name.is_empty() {
        "the cross street"
    } else {
        &m.cross_name
    };
    let assumed = if m.inferred { " (assumed)" } else { "" };
    match m.control {
        MovementControl::Signal => format!(
            "signal at {cross}{}",
            if m.turn == Turn::Left { " (left turn)" } else { "" }
        ),
        MovementControl::AllWayStop => format!("all-way stop at {cross}"),
        MovementControl::Stop => format!(
            "{} {cross} from a stop sign{assumed}",
            match m.turn {
                Turn::Left => "left onto",
                Turn::Right => "right onto",
                _ => "cross",
            }
        ),
        MovementControl::GiveWay => format!("yield to {cross}{assumed}"),
        MovementControl::MajorLeft => format!("left across oncoming traffic onto {cross}"),
        _ => {
            if m.turn == Turn::Straight {
                format!("through {cross}")
            } else {
                format!("{} onto {cross}", m.turn.as_str())
            }
        }
    }
}
