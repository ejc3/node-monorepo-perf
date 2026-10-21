//! `engine/src/compute.ts`: the plan call over a loaded area (`planTrip`), with its request read
//! from JSON and its result written as `JSON.stringify` writes the TypeScript's objects: the same
//! keys, in the same order, with the same number spelling.

use serde::Deserialize;

use crate::describe::{route_line, via_names};
use crate::geo::LatLon;
use crate::graph::{build_graph, nearest_vertex, Graph};
use crate::json::Json;
use crate::pack::{self, AreaPack, RoadData};
use crate::plan::{plan, DeparturePoint, Goal, PlanOptions};
use crate::router::{MovementStats, Route};
use crate::simulate::SimOptions;
use crate::traffic::Cal;

/// `AreaModel`: a loaded area, and the routes of its last plan.
pub struct AreaModel {
    pub id: String,
    pub g: Graph,
    pub cal: Cal,
    pub stats: MovementStats,
    /// The last plan's routes, by key ("r0", "r1", …).
    pub routes: Vec<(String, Route)>,
}

/// `loadArea`.
pub fn load_area(id: &str, pack: &AreaPack) -> AreaModel {
    area_from_data(id, &pack.data, pack.calibration.as_ref())
}

/// An area model straight from road data and a calibration (what `loadArea` builds from a pack).
pub fn area_from_data(id: &str, data: &RoadData, calibration: Option<&pack::Calibration>) -> AreaModel {
    let g = build_graph(data);
    let cal = Cal::new(calibration, &g);
    AreaModel {
        id: id.to_owned(),
        g,
        cal,
        stats: MovementStats::new(),
        routes: Vec::new(),
    }
}

#[derive(Deserialize, Clone, Copy)]
pub struct LatLonReq {
    pub lat: f64,
    pub lon: f64,
}

impl From<LatLonReq> for LatLon {
    fn from(p: LatLonReq) -> LatLon {
        LatLon::new(p.lat, p.lon)
    }
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct GoalReq {
    pub arrive_by_minute: f64,
    pub confidence: f64,
    pub early_minutes: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequest {
    pub from: LatLonReq,
    pub to: LatLonReq,
    pub goal: GoalReq,
    pub runs: f64,
    #[serde(default)]
    pub window_minutes: Option<f64>,
    #[serde(default)]
    pub step_minutes: Option<f64>,
}

/// A request's run count: the TypeScript loops `k < runs` and sizes arrays by it, so only a
/// whole, non-negative number of runs means anything.
fn runs_of(runs: f64) -> Result<usize, String> {
    if runs.is_finite() && runs >= 0.0 && runs.fract() == 0.0 && runs <= 1e7 {
        Ok(runs as usize)
    } else {
        Err(format!(
            "runs must be a whole number, not {}",
            crate::jsnum::number_to_string(runs)
        ))
    }
}

fn vertex_near(g: &Graph, p: LatLon) -> Result<usize, String> {
    let v = nearest_vertex(g, p);
    if v < 0 {
        Err("no road in this area to start or end on".to_owned())
    } else {
        Ok(v as usize)
    }
}

fn write_point(j: &mut Json, p: &DeparturePoint) {
    j.obj()
        .key("departMinute")
        .num(p.depart_minute)
        .key("p10Sec")
        .num(p.p10_sec)
        .key("p50Sec")
        .num(p.p50_sec)
        .key("p90Sec")
        .num(p.p90_sec)
        .key("onTime")
        .num(p.on_time)
        .key("dots")
        .nums(&p.dots)
        .end_obj();
}

/// `planTrip`.
pub fn plan_trip(area: &mut AreaModel, req: &PlanRequest) -> Result<String, String> {
    let runs = runs_of(req.runs)?;
    let AreaModel { g, cal, stats, .. } = area;
    let from = vertex_near(g, req.from.into())?;
    let to = vertex_near(g, req.to.into())?;
    let goal = Goal {
        arrive_by_minute: req.goal.arrive_by_minute,
        confidence: req.goal.confidence,
        early_minutes: req.goal.early_minutes,
    };
    let o = PlanOptions {
        window_minutes: req.window_minutes.unwrap_or(60.0),
        step_minutes: req.step_minutes.unwrap_or(2.0),
        ..PlanOptions::new(goal, SimOptions::new(runs, 7.0))
    };
    let choices = plan(g, cal, stats, from, to, &o);
    // Two routes must not read the same: lengthen a repeated name until it differs.
    let names: Vec<Vec<String>> = choices.iter().map(|c| via_names(g, &c.route, 5)).collect();
    let label = |k: usize, j: usize| names[j][..k.min(names[j].len())].join(", ");
    let mut out = Json::new();
    out.obj().key("routes").arr();
    for (i, c) in choices.iter().enumerate() {
        let mut n = 2;
        while n < names[i].len() && (0..choices.len()).any(|j| j != i && label(n, j) == label(n, i)) {
            n += 1;
        }
        out.obj()
            .key("key")
            .str(&format!("r{i}"))
            .key("via")
            .strs(&names[i][..n.min(names[i].len())])
            .key("miles")
            .num(c.route.length_m / 1609.344)
            .key("line")
            .pairs(&route_line(g, &c.route))
            .key("leaveBy")
            .opt_num(c.leave_by)
            .key("curve")
            .arr();
        for p in &c.curve {
            write_point(&mut out, p);
        }
        out.end_arr().key("atLeaveBy");
        match &c.leave_point {
            Some(p) => write_point(&mut out, p),
            None => {
                out.null();
            }
        }
        let mut spots: Vec<_> = c.at_leave_by.hotspots.iter().collect();
        spots.sort_by(|a, b| b.p90_sec.partial_cmp(&a.p90_sec).unwrap_or(std::cmp::Ordering::Equal));
        out.key("hotspots").arr();
        for h in spots.into_iter().take(6) {
            out.obj()
                .key("lat")
                .num(h.lat)
                .key("lon")
                .num(h.lon)
                .key("name")
                .str(&h.name)
                .key("control")
                .str(h.control.as_str())
                .key("assumed")
                .bool(h.inferred)
                .key("typicalSec")
                .num(h.p50_sec)
                .key("badSec")
                .num(h.p90_sec)
                .end_obj();
        }
        out.end_arr().end_obj();
    }
    out.end_arr().end_obj();
    area.routes = choices
        .into_iter()
        .enumerate()
        .map(|(i, c)| (format!("r{i}"), c.route))
        .collect();
    Ok(out.out)
}
