//! `engine/src/plan.ts`: for each candidate route the latest departure that still makes the
//! goal, and the routes ranked by it.

use std::cmp::Ordering;

use crate::graph::Graph;
use crate::jsmath::{js_floor, js_min};
use crate::router::{alternatives, overlap, shortest_path, MovementStats, Pricing, Route, SearchOptions};
use crate::simulate::{on_time_share, quantile, simulate_route, SimOptions, SimResult};
use crate::traffic::Cal;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Goal {
    pub arrive_by_minute: f64,
    /// e.g. 0.95: arrive on time on 95 mornings of 100.
    pub confidence: f64,
    /// Arrive this many minutes before `arrive_by_minute`.
    pub early_minutes: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DeparturePoint {
    pub depart_minute: f64,
    pub p10_sec: f64,
    pub p50_sec: f64,
    pub p90_sec: f64,
    pub on_time: f64,
    /// Twenty door-to-door times (s): the 2.5th, 7.5th, … 97.5th percentiles.
    pub dots: Vec<f64>,
}

/// `departureCurve`: each departure from `from_minute` to `to_minute`, every `step_minutes`.
#[allow(clippy::too_many_arguments)]
pub fn departure_curve(
    g: &Graph,
    cal: &Cal,
    stats: &mut MovementStats,
    route: &Route,
    goal: &Goal,
    from_minute: f64,
    to_minute: f64,
    step_minutes: f64,
    o: &SimOptions,
) -> Vec<DeparturePoint> {
    let target = goal.arrive_by_minute - goal.early_minutes;
    let mut out: Vec<DeparturePoint> = Vec::new();
    let mut m = from_minute;
    while m <= to_minute + 1e-9 {
        // The same seed at every departure, so the curve's steps are the traffic, not the dice.
        let sim = simulate_route(g, cal, stats, route, m, o, false);
        out.push(departure_point(&sim, m, target));
        m += step_minutes;
    }
    // Leaving later never makes arriving by a fixed time likelier: a rise is noise.
    for i in 1..out.len() {
        out[i].on_time = js_min(out[i].on_time, out[i - 1].on_time);
    }
    out
}

/// `departurePoint`: one departure's numbers, all from the one simulation.
pub fn departure_point(sim: &SimResult, depart_minute: f64, target: f64) -> DeparturePoint {
    DeparturePoint {
        depart_minute,
        p10_sec: sim.p10_sec,
        p50_sec: sim.p50_sec,
        p90_sec: sim.p90_sec,
        on_time: on_time_share(sim, target),
        dots: (0..20)
            .map(|i| quantile(&sim.samples, (i as f64 + 0.5) / 20.0))
            .collect(),
    }
}

/// `leaveBy`: the latest departure on the curve meeting the goal's confidence, interpolated.
pub fn leave_by(curve: &[DeparturePoint], goal: &Goal) -> Option<f64> {
    let mut best = None;
    for i in 0..curve.len() {
        let p = &curve[i];
        if p.on_time < goal.confidence {
            continue;
        }
        best = Some(p.depart_minute);
        if let Some(n) = curve.get(i + 1) {
            if n.on_time < goal.confidence {
                best = Some(
                    p.depart_minute
                        + ((p.on_time - goal.confidence) / (p.on_time - n.on_time))
                            * (n.depart_minute - p.depart_minute),
                );
            }
        }
    }
    best
}

/// `stableLeaveBy`: a new answer within `hysteresis_min` of the last keeps the last; whole minutes.
pub fn stable_leave_by(previous: Option<f64>, next: f64, hysteresis_min: f64) -> f64 {
    let n = js_floor(next);
    match previous {
        None => n,
        Some(p) => {
            if (n - p).abs() < hysteresis_min {
                p
            } else {
                n
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Label {
    Beaten,
    Analysed,
}

#[derive(Clone, Debug)]
pub struct RouteChoice {
    pub label: Label,
    pub route: Route,
    pub leave_by: Option<f64>,
    /// The simulation at the leave-by minute (or the first departure tried, when none makes it).
    pub at_leave_by: SimResult,
    pub leave_point: Option<DeparturePoint>,
    pub curve: Vec<DeparturePoint>,
}

#[derive(Clone, Copy, Debug)]
pub struct PlanOptions {
    pub goal: Goal,
    pub sim: SimOptions,
    pub max_routes: usize,
    pub window_minutes: f64,
    pub step_minutes: f64,
    pub alternatives: usize,
}

impl PlanOptions {
    /// `plan`'s defaults: 5 routes, a 60-minute window, 2-minute steps, 4 alternatives.
    pub fn new(goal: Goal, sim: SimOptions) -> Self {
        PlanOptions {
            goal,
            sim,
            max_routes: 5,
            window_minutes: 60.0,
            step_minutes: 2.0,
            alternatives: 4,
        }
    }
}

/// `plan`: candidate routes (the beaten path and our own), each with its departure curve and
/// leave-by time, latest safe departure first.
pub fn plan(
    g: &Graph,
    cal: &Cal,
    stats: &mut MovementStats,
    from: usize,
    to: usize,
    o: &PlanOptions,
) -> Vec<RouteChoice> {
    let goal = &o.goal;
    let window = o.window_minutes;
    let step = o.step_minutes;
    let depart_from = goal.arrive_by_minute - window;
    // Route around the middle of the window; the curve then prices each route at every departure.
    let route_at = goal.arrive_by_minute - 25.0;
    let mut candidates: Vec<(Label, Route)> = Vec::new();
    let beaten = shortest_path(
        g,
        cal,
        stats,
        from,
        to,
        &SearchOptions {
            pricing: Pricing::Beaten,
            ..SearchOptions::new(route_at, 0.0)
        },
    );
    if let Some(b) = beaten {
        candidates.push((Label::Beaten, b));
    }
    let risks: &[f64] = if from == to { &[] } else { &[0.0, 1.5] };
    for &risk in risks {
        let alts = alternatives(
            g,
            cal,
            stats,
            from,
            to,
            &SearchOptions::new(route_at, risk),
            o.alternatives,
            0.75,
        );
        for r in alts {
            if candidates
                .iter()
                .all(|(_, c)| overlap(g, &r, c) < 0.9 || overlap(g, c, &r) < 0.9)
            {
                candidates.push((Label::Analysed, r));
            }
        }
    }
    let target = goal.arrive_by_minute - goal.early_minutes;
    let mut choices: Vec<RouteChoice> = Vec::with_capacity(candidates.len());
    for (label, route) in candidates {
        let curve = departure_curve(
            g,
            cal,
            stats,
            &route,
            goal,
            depart_from,
            goal.arrive_by_minute,
            step,
            &o.sim,
        );
        let mut lb = leave_by(&curve, goal);
        // The leave-by time is a whole minute simulated on its own, and must meet the goal on its
        // own: step back a minute at a time to the latest that does.
        let first = lb.map_or(depart_from, js_floor);
        let mut at = simulate_route(g, cal, stats, &route, first, &o.sim, true);
        if let Some(l) = lb {
            let mut floor = depart_from;
            for p in &curve {
                if p.depart_minute <= l && p.on_time >= goal.confidence && p.depart_minute > floor {
                    floor = p.depart_minute;
                }
            }
            let mut m = js_floor(l);
            while m > floor && on_time_share(&at, target) < goal.confidence {
                m -= 1.0;
                at = simulate_route(g, cal, stats, &route, m, &o.sim, true);
            }
            lb = Some(m);
        }
        let leave_point = lb.map(|l| departure_point(&at, l, target));
        choices.push(RouteChoice {
            label,
            route,
            leave_by: lb,
            at_leave_by: at,
            leave_point,
            curve,
        });
    }
    // Latest safe departure first; a route that never makes it goes last. Two that never make
    // it compare as NaN in the TypeScript, which a sort reads as equal.
    choices.sort_by(|a, b| {
        let d = b.leave_by.unwrap_or(f64::NEG_INFINITY) - a.leave_by.unwrap_or(f64::NEG_INFINITY);
        if d < 0.0 {
            Ordering::Less
        } else if d > 0.0 {
            Ordering::Greater
        } else {
            Ordering::Equal
        }
    });
    let max = o.max_routes;
    let usual = choices.iter().position(|c| c.label == Label::Beaten);
    let mut kept_idx: Vec<usize> = (0..choices.len().min(max)).collect();
    if let Some(u) = usual {
        if !kept_idx.contains(&u) {
            if let Some(last) = kept_idx.last_mut() {
                *last = u;
            }
        }
    }
    let mut slots: Vec<Option<RouteChoice>> = choices.into_iter().map(Some).collect();
    kept_idx
        .into_iter()
        .map(|i| slots[i].take().expect("each kept once"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(depart_minute: f64, on_time: f64) -> DeparturePoint {
        DeparturePoint {
            depart_minute,
            p10_sec: 0.0,
            p50_sec: 0.0,
            p90_sec: 0.0,
            on_time,
            dots: vec![],
        }
    }

    #[test]
    fn leave_by_interpolates_to_the_confidence_line_and_a_small_wobble_does_not_move_a_routine() {
        let curve = [pt(450.0, 1.0), pt(460.0, 0.97), pt(470.0, 0.87)];
        let goal = |confidence| Goal {
            arrive_by_minute: 490.0,
            confidence,
            early_minutes: 0.0,
        };
        assert_eq!(leave_by(&curve, &goal(0.95)), Some(462.0));
        assert_eq!(leave_by(&curve, &goal(1.01)), None);
        assert_eq!(stable_leave_by(Some(462.0), 463.9, 3.0), 462.0);
        assert_eq!(stable_leave_by(Some(462.0), 458.5, 3.0), 458.0);
    }
}
