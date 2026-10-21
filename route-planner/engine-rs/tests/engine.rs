//! `engine/test/engine.test.ts`, ported to the Rust engine: the same fixtures, numbers and
//! tolerances. Not ported: the pack round-trip (`toPack` is TypeScript only).

use std::collections::BTreeSet;

use route_planner_engine::geo::LatLon;
use route_planner_engine::graph::{
    build_graph, edge_under, movement_allowed, nearest_vertex, place_controls, way_pieces, Edge, Graph,
};
use route_planner_engine::intersection::{
    describe_movement, gap_capacity, sample_delay, DelayContext, MovementControl, Turn,
};
use route_planner_engine::osm::{from_overpass, street_key};
use route_planner_engine::pack::{Calibration, Control, ControlPoint, JsObject, RoadData, Stretch, SurveyedControl};
use route_planner_engine::plan::{leave_by, plan, stable_leave_by, DeparturePoint, Goal, PlanOptions};
use route_planner_engine::random::Rng;
use route_planner_engine::router::{shortest_path, MovementStats, Route, SearchOptions};
use route_planner_engine::simulate::{simulate_route, SimOptions};
use route_planner_engine::traffic::{edge_day_factor, free_flow_time, lanes_per_direction, running_time, Cal};
use serde_json::{json, Value};

// A plus-shaped junction: Main St (primary) east–west through node 1, Elm St (residential)
// north–south through it. Node ids: 1 centre; 10/11 west/east; 20/21 north/south; 22 a
// stop sign on Elm 20 m north of the centre.
const D: f64 = 0.0018; // ~200 m in latitude

fn nd(id: i64, lat: f64, lon: f64, tags: Option<Value>) -> Value {
    match tags {
        Some(tags) => json!({ "type": "node", "id": id, "lat": lat, "lon": lon, "tags": tags }),
        None => json!({ "type": "node", "id": id, "lat": lat, "lon": lon }),
    }
}

fn node(id: i64, lat: f64, lon: f64) -> Value {
    nd(id, lat, lon, None)
}

fn way(id: i64, nodes: &[i64], tags: Value) -> Value {
    json!({ "type": "way", "id": id, "nodes": nodes, "tags": tags })
}

fn road(elements: Vec<Value>) -> RoadData {
    from_overpass(&elements)
}

fn with_survey(mut data: RoadData, lat: f64, lon: f64, streets: &[&str], control: SurveyedControl) -> RoadData {
    data.control_points.get_or_insert_with(Vec::new).push(ControlPoint {
        lat,
        lon,
        control,
        streets: streets.iter().map(|s| (*s).to_owned()).collect(),
    });
    data
}

#[derive(Default)]
struct Extra {
    stop_tags: Option<Value>,
    centre_tags: Option<Value>,
    relations: Vec<Value>,
}

fn plus(extra: Extra) -> Graph {
    let mut elements = vec![
        nd(1, 0.0, 0.0, extra.centre_tags),
        node(10, 0.0, -D),
        node(11, 0.0, D),
        node(20, D, 0.0),
        node(21, -D, 0.0),
        nd(22, 0.00018, 0.0, extra.stop_tags),
        way(100, &[10, 1], json!({ "highway": "primary", "name": "Main St" })),
        way(101, &[1, 11], json!({ "highway": "primary", "name": "Main St" })),
        way(200, &[20, 22, 1], json!({ "highway": "residential", "name": "Elm St" })),
        way(201, &[1, 21], json!({ "highway": "residential", "name": "Elm St" })),
    ];
    elements.extend(extra.relations);
    build_graph(&road(elements))
}

fn stop_forward() -> Option<Value> {
    Some(json!({ "highway": "stop", "direction": "forward" }))
}

fn signal_centre() -> Extra {
    Extra {
        centre_tags: Some(json!({ "highway": "traffic_signals" })),
        ..Default::default()
    }
}

/// The edge of `way` that ends at OSM node `to_node`.
fn edge(g: &Graph, way: i64, to_node: i64) -> &Edge {
    g.edges
        .iter()
        .find(|e| e.way == way && g.vertices[e.to].node == to_node)
        .unwrap()
}

/// The edge of `way` that starts at OSM node `from_node`.
fn edge_from(g: &Graph, way: i64, from_node: i64) -> &Edge {
    g.edges
        .iter()
        .find(|e| e.way == way && g.vertices[e.from].node == from_node)
        .unwrap()
}

fn cal_of(g: &Graph) -> Cal {
    Cal::new(None, g)
}

fn vertex(g: &Graph, node: i64) -> usize {
    g.vertex_of_node[&node]
}

fn route_between(
    g: &Graph,
    cal: &Cal,
    stats: &mut MovementStats,
    from: usize,
    to: usize,
    depart: f64,
) -> Option<Route> {
    shortest_path(g, cal, stats, from, to, &SearchOptions::new(depart, 0.0))
}

fn goal(arrive_by_minute: f64, confidence: f64) -> Goal {
    Goal {
        arrive_by_minute,
        confidence,
        early_minutes: 0.0,
    }
}

fn first_seen(xs: impl Iterator<Item = i64>) -> Vec<i64> {
    let mut out = Vec::new();
    for x in xs {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

#[test]
fn a_stop_tagged_forward_governs_only_the_approach_travelling_in_way_order() {
    let g = plus(Extra {
        stop_tags: stop_forward(),
        ..Default::default()
    });
    assert_eq!(edge(&g, 200, 1).control, Some(Control::Stop));
    assert!(!edge(&g, 200, 1).control_inferred);
    assert_eq!(
        edge(&g, 200, 20).control,
        None,
        "leaving the junction meets nothing at its far end"
    );
    assert_eq!(edge(&g, 100, 1).control, None, "the major road runs free");
}

#[test]
fn an_untagged_minor_approach_is_inferred_to_stop_and_says_it_was_inferred() {
    let g = plus(Extra::default());
    let south = edge(&g, 201, 1);
    assert_eq!(south.control, Some(Control::Stop));
    assert!(south.control_inferred);
}

#[test]
fn a_signal_on_the_junction_node_governs_every_approach() {
    let g = plus(signal_centre());
    for (w, n) in [(100, 1), (101, 1), (200, 1), (201, 1)] {
        assert_eq!(edge(&g, w, n).control, Some(Control::Signal));
    }
}

#[test]
fn gap_capacity_is_finite_with_no_conflicting_traffic_and_falls_as_it_grows() {
    assert_eq!(gap_capacity(0.0, 6.5, 4.0), 900.0);
    let c: Vec<f64> = [100.0, 500.0, 1000.0, 1500.0]
        .iter()
        .map(|&v| gap_capacity(v, 6.5, 4.0))
        .collect();
    for i in 1..c.len() {
        assert!(c[i] < c[i - 1]);
    }
}

#[test]
fn crossing_the_busy_road_from_a_stop_sign_is_slower_at_the_peak_than_at_dawn() {
    let g = plus(Extra {
        stop_tags: stop_forward(),
        ..Default::default()
    });
    let cal = cal_of(&g);
    let cross = describe_movement(&g, edge(&g, 200, 1).id, edge_from(&g, 201, 1).id);
    assert_eq!(cross.control, MovementControl::Stop);
    assert_eq!(cross.turn, Turn::Straight);
    let mean = |minute: f64| {
        let mut r = Rng::new(1);
        let mut s = 0.0;
        for _ in 0..2000 {
            let ctx = DelayContext {
                minute_of_day: minute,
                day_factor: 1.0,
                cal: &cal,
            };
            s += sample_delay(&g, &cross, &ctx, &mut r).seconds;
        }
        s / 2000.0
    };
    assert!(
        mean(8.0 * 60.0) > mean(5.0 * 60.0) + 2.0,
        "peak {} vs dawn {}",
        mean(8.0 * 60.0),
        mean(5.0 * 60.0)
    );
}

#[test]
fn a_no_left_turn_restriction_is_obeyed_by_the_movement_check_and_the_router() {
    let g = plus(Extra {
        relations: vec![json!({
            "type": "relation", "id": 9, "tags": { "type": "restriction", "restriction": "no_left_turn" },
            "members": [
                { "type": "way", "ref": 200, "role": "from" },
                { "type": "node", "ref": 1, "role": "via" },
                { "type": "way", "ref": 101, "role": "to" },
            ],
        })],
        ..Default::default()
    });
    let southbound = edge(&g, 200, 1);
    let east = edge_from(&g, 101, 1);
    assert!(!movement_allowed(&g, southbound, east));
    let cal = cal_of(&g);
    let mut stats = MovementStats::new();
    let route = route_between(&g, &cal, &mut stats, vertex(&g, 20), vertex(&g, 11), 480.0);
    assert_eq!(
        route, None,
        "the only way east from Elm north is the forbidden left (no turning round at a dead end)"
    );
}

#[test]
fn a_simulation_is_a_pure_function_of_its_seed() {
    let g = plus(Extra::default());
    let cal = cal_of(&g);
    let mut stats = MovementStats::new();
    let route = route_between(&g, &cal, &mut stats, vertex(&g, 20), vertex(&g, 21), 480.0).unwrap();
    let o = SimOptions::new(200, 5.0);
    let a = simulate_route(&g, &cal, &mut stats, &route, 480.0, &o, false);
    let b = simulate_route(&g, &cal, &mut MovementStats::new(), &route, 480.0, &o, false);
    assert_eq!(a.samples, b.samples);
    assert!(a.p90_sec >= a.p50_sec && a.p50_sec >= a.p10_sec);
}

#[test]
fn leave_by_interpolates_to_the_confidence_line_and_a_small_wobble_does_not_move_a_routine() {
    let pt = |depart_minute: f64, on_time: f64| DeparturePoint {
        depart_minute,
        p10_sec: 0.0,
        p50_sec: 0.0,
        p90_sec: 0.0,
        on_time,
        dots: vec![],
    };
    let curve = [pt(450.0, 1.0), pt(460.0, 0.97), pt(470.0, 0.87)];
    assert_eq!(leave_by(&curve, &goal(490.0, 0.95)), Some(462.0));
    assert_eq!(leave_by(&curve, &goal(490.0, 1.01)), None);
    assert_eq!(stable_leave_by(Some(462.0), 463.9, 3.0), 462.0);
    assert_eq!(stable_leave_by(Some(462.0), 458.5, 3.0), 458.0);
}

// Regression tests for the first review of the engine.

#[test]
fn an_only_turn_onto_a_road_the_extract_does_not_hold_is_dropped_not_a_dead_end() {
    // Way 7 runs 1→2; at 2 the only allowed turn is onto way 99, which a long area left out.
    let g2 = build_graph(&road(vec![
        node(1, 0.0, 0.0),
        node(2, D, 0.0),
        node(3, D, D),
        node(4, 2.0 * D, 0.0),
        way(7, &[1, 2], json!({ "highway": "primary" })),
        way(8, &[2, 3], json!({ "highway": "primary" })),
        way(9, &[2, 4], json!({ "highway": "primary" })),
        json!({
            "type": "relation", "id": 50, "tags": { "type": "restriction", "restriction": "only_left_turn" },
            "members": [
                { "type": "way", "ref": 7, "role": "from" },
                { "type": "node", "ref": 2, "role": "via" },
                { "type": "way", "ref": 99, "role": "to" },
            ],
        }),
    ]));
    let into = edge(&g2, 7, 2);
    let out: Vec<&Edge> = g2.vertices[into.to]
        .out
        .iter()
        .map(|&i| &g2.edges[i])
        .filter(|e| e.way != 7)
        .collect();
    assert_eq!(out.len(), 2);
    assert!(
        out.iter().all(|e| movement_allowed(&g2, into, e)),
        "both ways on stay open"
    );
}

#[test]
fn a_no_u_turn_whose_from_and_to_are_one_way_forbids_turning_back_not_carrying_on() {
    let g2 = build_graph(&road(vec![
        node(1, 0.0, 0.0),
        node(2, D, 0.0),
        node(3, -D, 0.0),
        node(4, 0.0, D),
        way(7, &[2, 1, 3], json!({ "highway": "residential" })),
        way(8, &[1, 4], json!({ "highway": "residential" })),
        json!({
            "type": "relation", "id": 9, "tags": { "type": "restriction", "restriction": "no_u_turn" },
            "members": [
                { "type": "way", "ref": 7, "role": "from" },
                { "type": "node", "ref": 1, "role": "via" },
                { "type": "way", "ref": 7, "role": "to" },
            ],
        }),
    ]));
    let south_in = edge(&g2, 7, 1);
    let find = |to: i64| {
        g2.edges
            .iter()
            .find(|e| e.way == 7 && g2.vertices[e.from].node == 1 && g2.vertices[e.to].node == to)
            .unwrap()
    };
    assert!(
        movement_allowed(&g2, south_in, find(3)),
        "straight on along the same way"
    );
    assert!(!movement_allowed(&g2, south_in, find(2)), "but not back");
}

#[test]
fn lanes_on_a_one_way_road_are_all_its_own() {
    let g = build_graph(&road(vec![
        node(1, 0.0, 0.0),
        node(2, 0.0, D),
        node(3, D, 0.0),
        node(4, D, D),
        way(
            1,
            &[1, 2],
            json!({ "highway": "primary", "oneway": "yes", "lanes": "2" }),
        ),
        way(2, &[3, 4], json!({ "highway": "primary", "lanes": "2" })),
    ]));
    assert_eq!(lanes_per_direction(g.edges.iter().find(|e| e.way == 1).unwrap()), 2.0);
    assert_eq!(lanes_per_direction(g.edges.iter().find(|e| e.way == 2).unwrap()), 1.0);
}

#[test]
fn a_trip_that_starts_where_it_ends_is_empty() {
    let g = plus(Extra::default());
    let cal = cal_of(&g);
    let v = vertex(&g, 20);
    assert_eq!(
        route_between(&g, &cal, &mut MovementStats::new(), v, v, 480.0),
        Some(Route {
            edges: vec![],
            length_m: 0.0
        })
    );
}

#[test]
fn entering_a_roundabout_yields_motorcar_access_overrides_motor_vehicle() {
    let g = build_graph(&road(vec![
        node(1, 0.0, 0.0),
        node(2, 0.0002, 0.0002),
        node(3, 0.0, 0.0004),
        node(4, 0.0, -D),
        node(5, D, -D),
        node(6, D, 0.0),
        way(
            1,
            &[1, 2, 3, 1],
            json!({ "highway": "residential", "junction": "roundabout" }),
        ),
        way(2, &[4, 1], json!({ "highway": "residential" })),
        way(
            3,
            &[5, 6],
            json!({ "highway": "residential", "motor_vehicle": "yes", "motorcar": "no" }),
        ),
    ]));
    assert_eq!(edge(&g, 2, 1).control, Some(Control::GiveWay));
    assert!(!g.edges.iter().any(|e| e.way == 3));
}

#[test]
fn the_a_star_bound_never_exceeds_a_routes_free_flow_time_at_any_speed_scale() {
    let g = plus(Extra::default());
    let faster = Calibration {
        speed_scale: Some(1.2),
        ..Default::default()
    };
    for calibration in [None, Some(&faster)] {
        let cal = Cal::new(calibration, &g);
        let mut stats = MovementStats::new();
        for to in 0..g.vertices.len() {
            for from in 0..g.vertices.len() {
                // A separate cache for the bound: the router grows its own.
                let mut bound_stats = MovementStats::new();
                let bound = bound_stats.free_flow.grow(&g, &cal, to, from);
                // Every vertex, reached by the backward search or not, on every route from `from`.
                for v in 0..g.vertices.len() {
                    let Some(r) = route_between(&g, &cal, &mut stats, v, to, 480.0) else {
                        continue;
                    };
                    let mut free = 0.0;
                    for &ei in &r.edges {
                        free += free_flow_time(&g.edges[ei], &cal);
                    }
                    assert!(
                        bound.to_go(v) <= free + 1e-9,
                        "{v}->{to} (searching from {from}): bound {} > {free}",
                        bound.to_go(v)
                    );
                }
            }
        }
    }
}

#[test]
fn an_origin_that_cannot_reach_the_destination_does_not_send_the_a_star_bound_over_the_whole_area() {
    // A 33 km road from the destination (node 1), and a 100 m piece of road on its own beside it.
    let chain: Vec<i64> = (1..=300).collect();
    let mut elements: Vec<Value> = chain.iter().map(|&id| node(id, 0.0, (id - 1) as f64 * 0.001)).collect();
    elements.push(node(1001, 0.0009, 0.0));
    elements.push(node(1002, 0.0009, 0.0005));
    // Separate ways, so the road has a vertex every 110 m, as a road with side streets has.
    for i in 0..299 {
        elements.push(way(
            10 + i as i64,
            &[chain[i], chain[i + 1]],
            json!({ "highway": "residential" }),
        ));
    }
    elements.push(way(2, &[1001, 1002], json!({ "highway": "residential" })));
    let g = build_graph(&road(elements));
    let cal = cal_of(&g);
    let (to, from, far) = (vertex(&g, 1), vertex(&g, 1001), vertex(&g, 300));
    let mut stats = MovementStats::new();
    let bound = stats.free_flow.grow(&g, &cal, to, from);
    let mut far_free = 0.0;
    for e in g
        .edges
        .iter()
        .filter(|e| e.way >= 10 && g.vertices[e.to].node < g.vertices[e.from].node)
    {
        far_free += free_flow_time(e, &cal);
    }
    assert!(
        bound.to_go(far) < far_free / 2.0,
        "stopped near the destination: bound at the far end {} s of {far_free} s",
        bound.to_go(far)
    );
    assert!(bound.to_go(far) <= far_free, "and still a lower bound");
}

#[test]
fn access_destination_costs_nothing_along_the_whole_way_the_trip_starts_on() {
    // A destination-only street split into three pieces; the trip starts at its far end.
    let g = build_graph(&road(vec![
        node(1, 0.0, 0.0),
        node(2, 0.0, D),
        node(3, 0.0, 2.0 * D),
        node(4, 0.0, 3.0 * D),
        node(5, D, D),
        node(6, D, 2.0 * D),
        node(7, -D, 3.0 * D),
        way(
            1,
            &[1, 2, 3, 4],
            json!({ "highway": "residential", "access": "destination" }),
        ),
        way(2, &[5, 2], json!({ "highway": "residential" })),
        way(3, &[6, 3], json!({ "highway": "residential" })),
        way(4, &[4, 7], json!({ "highway": "residential" })),
        way(5, &[5, 6], json!({ "highway": "residential" })), // a detour round the middle piece
    ]));
    let cal = cal_of(&g);
    let r = route_between(&g, &cal, &mut MovementStats::new(), vertex(&g, 1), vertex(&g, 7), 300.0).unwrap();
    assert_eq!(
        first_seen(r.edges.iter().map(|&e| g.edges[e].way)),
        vec![1, 4],
        "straight along the access way, no detour"
    );
}

#[test]
fn a_ramp_never_makes_the_street_it_meets_stop_and_merges_onto_a_freeway_with_no_control() {
    let g = build_graph(&road(vec![
        node(1, 0.0, 0.0),
        node(2, 0.0, -D),
        node(3, 0.0, D),
        node(4, D, 0.0),
        node(5, -D, D),
        node(6, -D, 2.0 * D),
        node(7, -D, 0.0),
        way(1, &[2, 1, 3], json!({ "highway": "primary", "name": "Oak Ave" })),
        way(2, &[1, 5], json!({ "highway": "motorway_link", "oneway": "yes" })),
        way(3, &[7, 5, 6], json!({ "highway": "motorway", "name": "CA-85" })),
        way(4, &[4, 1], json!({ "highway": "residential", "name": "Elm St" })),
    ]));
    assert_eq!(
        edge(&g, 1, 1).control,
        None,
        "the arterial does not stop for an on-ramp"
    );
    assert_eq!(
        edge(&g, 4, 1).control,
        Some(Control::Stop),
        "the side street still does"
    );
    assert_eq!(edge(&g, 2, 5).control, None, "the ramp merges");
}

#[test]
fn a_trip_that_starts_where_it_ends_plans_one_route_a_circular_junction_is_not_a_roundabout() {
    let g = plus(Extra::default());
    let cal = cal_of(&g);
    let v = vertex(&g, 20);
    let o = PlanOptions {
        window_minutes: 10.0,
        ..PlanOptions::new(goal(490.0, 0.95), SimOptions::new(20, 1.0))
    };
    let choices = plan(&g, &cal, &mut MovementStats::new(), v, v, &o);
    assert_eq!(choices.len(), 1);
    let c = build_graph(&road(vec![
        node(1, 0.0, 0.0),
        node(2, 0.0002, 0.0002),
        node(3, 0.0, 0.0004),
        node(4, 0.0, -D),
        way(
            1,
            &[1, 2, 3, 1],
            json!({ "highway": "residential", "junction": "circular" }),
        ),
        way(2, &[4, 1], json!({ "highway": "residential" })),
    ]));
    assert_eq!(edge(&c, 2, 1).control, None);
}

#[test]
fn a_surveyed_control_replaces_the_guess_none_all_way_signal_a_tagged_sign_is_kept() {
    let at = |control: SurveyedControl| {
        build_graph(&with_survey(
            road(vec![
                node(1, 0.0, 0.0),
                node(10, 0.0, -D),
                node(11, 0.0, D),
                node(20, D, 0.0),
                node(21, -D, 0.0),
                way(
                    100,
                    &[10, 1, 11],
                    json!({ "highway": "primary", "name": "Main Street" }),
                ),
                way(200, &[20, 1], json!({ "highway": "residential", "name": "Elm Avenue" })),
                way(201, &[1, 21], json!({ "highway": "residential", "name": "Elm Avenue" })),
            ]),
            0.00005,
            0.0,
            &["MAIN", "ELM"],
            control,
        ))
    };
    let none = at(SurveyedControl::None);
    assert_eq!(
        edge(&none, 200, 1).control,
        None,
        "no stop where the city says there is none"
    );
    assert!(!edge(&none, 200, 1).control_inferred);
    assert_eq!(
        edge(&at(SurveyedControl::AllWayStop), 100, 1).control,
        Some(Control::AllWayStop),
        "the main road stops too"
    );
    assert_eq!(
        edge(&at(SurveyedControl::Signal), 200, 1).control,
        Some(Control::Signal)
    );
    let kept = build_graph(&with_survey(
        road(vec![
            node(1, 0.0, 0.0),
            node(10, 0.0, -D),
            node(11, 0.0, D),
            node(20, D, 0.0),
            nd(22, 0.00018, 0.0, stop_forward()),
            way(
                100,
                &[10, 1, 11],
                json!({ "highway": "primary", "name": "Main Street" }),
            ),
            way(
                200,
                &[20, 22, 1],
                json!({ "highway": "residential", "name": "Elm Avenue" }),
            ),
        ]),
        0.0,
        0.0,
        &["MAIN"],
        SurveyedControl::None,
    ));
    assert_eq!(
        edge(&kept, 200, 1).control,
        Some(Control::Stop),
        "a sign mapped on the ground wins over the inventory"
    );
}

#[test]
fn street_names_from_two_sources_agree_oak_avenue_is_oak_av() {
    assert_eq!(street_key("Oak Avenue"), street_key("OAK AV"));
    assert_eq!(street_key("South Bascom Avenue"), street_key("S BASCOM AV"));
    assert_eq!(street_key("Almaden Expressway"), street_key("ALMADEN EX"));
}

// Regression tests for the review of the survey.

#[test]
fn a_one_way_arterial_carries_on_through_a_surveyed_side_street_stop() {
    let g = build_graph(&with_survey(
        road(vec![
            node(1, 0.0, 0.0),
            node(10, 0.0, -D),
            node(11, 0.0, D),
            node(20, D, 0.0),
            node(21, -D, 0.0),
            way(
                100,
                &[10, 1, 11],
                json!({ "highway": "primary", "name": "Hillsdale Avenue", "oneway": "yes" }),
            ),
            way(
                200,
                &[20, 1, 21],
                json!({ "highway": "residential", "name": "Jenkins Avenue" }),
            ),
        ]),
        0.0,
        0.0,
        &["HILLSDALE", "JENKINS"],
        SurveyedControl::Stop,
    ));
    assert_eq!(edge(&g, 100, 1).control, None, "the one-way arterial does not stop");
    assert_eq!(edge(&g, 200, 1).control, Some(Control::Stop));
}

#[test]
fn a_survey_lands_on_the_junction_naming_both_its_streets_a_nearby_survey_does_not_overwrite_it() {
    let e = 0.00035; // ~39 m east: a second junction along Bird
    let data = road(vec![
        node(1, 0.0, 0.0),
        node(2, 0.0, e),
        node(10, 0.0, -D),
        node(11, 0.0, D),
        node(20, D, 0.0),
        node(21, -D, 0.0),
        node(30, D, e),
        way(
            100,
            &[10, 1, 2, 11],
            json!({ "highway": "secondary", "name": "Bird Avenue" }),
        ),
        way(
            200,
            &[20, 1, 21],
            json!({ "highway": "secondary", "name": "Minnesota Avenue" }),
        ),
        way(
            300,
            &[30, 2],
            json!({ "highway": "residential", "name": "Vernon Avenue" }),
        ),
    ]);
    let data = with_survey(data, 0.0, 0.0, &["BIRD", "MINNESOTA"], SurveyedControl::Signal);
    // The city's point for Bird & Vernon sits nearer Bird & Minnesota than to its own junction.
    let data = with_survey(data, 0.0, 0.00015, &["BIRD", "VERNON"], SurveyedControl::Stop);
    let g = build_graph(&data);
    assert_eq!(edge(&g, 200, 1).control, Some(Control::Signal));
    assert_eq!(edge(&g, 300, 2).control, Some(Control::Stop));
}

#[test]
fn a_surveyed_2_way_stop_where_two_equal_streets_both_cross_a_mapped_sign_says_which_with_none_both_as_assumed() {
    let cross = |stop_tags: Option<Value>| {
        build_graph(&with_survey(
            road(vec![
                node(1, 0.0, 0.0),
                node(10, 0.0, -D),
                node(11, 0.0, D),
                node(20, D, 0.0),
                node(21, -D, 0.0),
                nd(22, 0.00018, 0.0, stop_tags),
                way(
                    100,
                    &[10, 1, 11],
                    json!({ "highway": "residential", "name": "Ewer Drive" }),
                ),
                way(
                    200,
                    &[20, 22, 1, 21],
                    json!({ "highway": "residential", "name": "Samson Drive" }),
                ),
            ]),
            0.0,
            0.0,
            &["EWER", "SAMSON"],
            SurveyedControl::Stop,
        ))
    };
    let tagged = cross(stop_forward());
    assert_eq!(edge(&tagged, 200, 1).control, Some(Control::Stop), "the mapped stop");
    assert_eq!(edge(&tagged, 100, 1).control, None, "the crossing street stays free");
    let unmapped = cross(None);
    assert_eq!(edge(&unmapped, 100, 1).control, Some(Control::Stop));
    assert!(edge(&unmapped, 100, 1).control_inferred);
    assert_eq!(edge(&unmapped, 200, 1).control, Some(Control::Stop));
}

#[test]
fn a_loop_street_carries_on_through_its_own_junction_two_arms_reaching_one_far_junction_are_two_arms() {
    // Loop Lane leaves Main Street at 1 and comes back to it there; Main Street has a mapped stop.
    let g = build_graph(&with_survey(
        road(vec![
            node(1, 0.0, 0.0),
            node(2, 0.0009, 0.0002),
            node(3, 0.0009, 0.0009),
            node(4, 0.0002, 0.0009),
            node(10, 0.0, -D),
            node(11, -D, 0.0),
            nd(12, 0.0, -0.00018, stop_forward()),
            way(
                100,
                &[10, 12, 1, 11],
                json!({ "highway": "residential", "name": "Main Street" }),
            ),
            way(
                300,
                &[1, 2, 3, 4, 1],
                json!({ "highway": "residential", "name": "Loop Lane" }),
            ),
            // A court off the far side of the loop makes 3 a junction: both arms from 1 reach it.
            node(5, 0.0018, 0.0018),
            way(400, &[3, 5], json!({ "highway": "residential", "name": "Far Court" })),
        ]),
        0.0,
        0.0,
        &["MAIN", "LOOP"],
        SurveyedControl::Stop,
    ));
    assert_eq!(
        edge(&g, 100, 1).control,
        Some(Control::Stop),
        "the mapped stop on Main Street"
    );
    let arms: Vec<&Edge> = g
        .edges
        .iter()
        .filter(|x| x.way == 300 && g.vertices[x.to].node == 1)
        .collect();
    assert_eq!(arms.len(), 2, "two arms of Loop Lane arrive at Main Street");
    for e in arms {
        assert_eq!(
            e.control, None,
            "Loop Lane carries on, so the mapped stop says Main is the street that stops"
        );
    }
}

// Regression tests for the second review of the survey.

#[test]
fn a_courts_surveyed_stop_is_not_evidence_about_the_crossing_streets_in_either_way_order() {
    let ways = vec![
        way(
            100,
            &[10, 1, 11],
            json!({ "highway": "residential", "name": "Ewer Drive" }),
        ),
        way(
            200,
            &[20, 1, 21],
            json!({ "highway": "residential", "name": "Samson Drive" }),
        ),
        way(
            300,
            &[30, 1],
            json!({ "highway": "residential", "name": "Harmil Court" }),
        ),
    ];
    let mut reversed = ways.clone();
    reversed.reverse();
    for order in [ways, reversed] {
        let mut elements = vec![
            node(1, 0.0, 0.0),
            node(10, 0.0, -D),
            node(11, 0.0, D),
            node(20, D, 0.0),
            node(21, -D, 0.0),
            node(30, D, D),
        ];
        elements.extend(order);
        let g = build_graph(&with_survey(
            road(elements),
            0.0,
            0.0,
            &["EWER", "SAMSON"],
            SurveyedControl::Stop,
        ));
        assert_eq!(
            edge(&g, 300, 1).control,
            Some(Control::Stop),
            "the court ends here: it stops"
        );
        assert!(!edge(&g, 300, 1).control_inferred);
        assert!(
            edge(&g, 100, 1).control_inferred,
            "which crossing street stops is still unknown"
        );
        assert!(edge(&g, 200, 1).control_inferred);
    }
}

#[test]
fn a_mapped_all_way_stop_on_one_approach_does_not_free_the_crossing_street() {
    let g = build_graph(&with_survey(
        road(vec![
            node(1, 0.0, 0.0),
            node(10, 0.0, -D),
            node(11, 0.0, D),
            node(20, D, 0.0),
            node(21, -D, 0.0),
            nd(
                22,
                0.00018,
                0.0,
                Some(json!({ "highway": "stop", "stop": "all", "direction": "forward" })),
            ),
            way(
                100,
                &[10, 1, 11],
                json!({ "highway": "residential", "name": "Ewer Drive" }),
            ),
            way(
                200,
                &[20, 22, 1, 21],
                json!({ "highway": "residential", "name": "Samson Drive" }),
            ),
        ]),
        0.0,
        0.0,
        &["EWER", "SAMSON"],
        SurveyedControl::Stop,
    ));
    assert_eq!(edge(&g, 100, 1).control, Some(Control::Stop));
}

#[test]
fn a_divided_side_street_is_one_leg_the_street_it_meets_stays_free() {
    // Elm Avenue (main) runs east-west through 1 and 2; Oak Avenue's two one-way halves leave
    // from 1 and 2 and rejoin at 5 to the south.
    let g = build_graph(&with_survey(
        road(vec![
            node(1, 0.0, 0.0),
            node(2, 0.0, 0.0002),
            node(10, 0.0, -D),
            node(11, 0.0, D),
            node(5, -D, 0.0001),
            node(6, -2.0 * D, 0.0001),
            node(7, -D / 2.0, -0.00005),
            node(8, -D / 2.0, 0.00025), // each half bends on its way to 5
            way(
                100,
                &[10, 1, 2, 11],
                json!({ "highway": "residential", "name": "Elm Avenue" }),
            ),
            way(
                200,
                &[5, 7, 1],
                json!({ "highway": "residential", "name": "Oak Avenue", "oneway": "yes" }),
            ),
            way(
                201,
                &[2, 8, 5],
                json!({ "highway": "residential", "name": "Oak Avenue", "oneway": "yes" }),
            ),
            way(202, &[6, 5], json!({ "highway": "residential", "name": "Oak Avenue" })),
        ]),
        0.0,
        0.0001,
        &["ELM", "OAK"],
        SurveyedControl::Stop,
    ));
    assert_eq!(
        edge(&g, 100, 1).control,
        None,
        "Elm Avenue does not stop for a divided side street"
    );
    assert_eq!(edge(&g, 200, 1).control, Some(Control::Stop));
}

#[test]
fn an_address_snaps_to_its_own_road_not_the_corner() {
    let g = plus(Extra {
        stop_tags: stop_forward(),
        ..Default::default()
    });
    // A house on Main St, 30 m from the junction but 5 m from Main St: it starts on Main St.
    let v = nearest_vertex(&g, LatLon::new(0.00005, 0.0012));
    assert_eq!(g.vertices[v as usize].node, 11);
}

#[test]
fn a_left_turn_at_a_signal_queues_only_the_left_turning_share_about_a_cycle_not_minutes() {
    let g = plus(signal_centre());
    let into_main = edge(&g, 100, 1);
    let left = edge_from(&g, 200, 1); // eastbound on Main, turning north onto Elm
    let m = describe_movement(&g, into_main.id, left.id);
    assert_eq!(m.control, MovementControl::Signal);
    assert_eq!(m.turn, Turn::Left);
    let busier = Calibration {
        volume_scale: Some(1.1),
        ..Default::default()
    };
    let cal = Cal::new(Some(&busier), &g);
    let mut r = Rng::new(3);
    let mut waits = Vec::new();
    for _ in 0..2000 {
        let ctx = DelayContext {
            minute_of_day: 480.0,
            day_factor: 1.0,
            cal: &cal,
        };
        waits.push(sample_delay(&g, &m, &ctx, &mut r).seconds);
    }
    waits.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert!(waits[1000] < 150.0, "median {} s", waits[1000]);
}

#[test]
fn a_crowded_freeway_slows_far_more_than_a_crowded_arterial_and_class_factors_apply_to_their_class_only() {
    let g = build_graph(&road(vec![
        node(1, 0.0, 0.0),
        node(2, 0.0, D),
        node(3, D, 0.0),
        node(4, D, D),
        way(
            1,
            &[1, 2],
            json!({ "highway": "motorway", "lanes": "3", "oneway": "yes" }),
        ),
        way(2, &[3, 4], json!({ "highway": "primary", "lanes": "4" })),
    ]));
    let cal = cal_of(&g);
    let fwy = g.edges.iter().find(|e| e.way == 1).unwrap();
    let art = g.edges.iter().find(|e| e.way == 2).unwrap();
    let ratio =
        |e: &Edge, day_factor: f64| running_time(e, 480.0, &cal, day_factor) / running_time(e, 180.0, &cal, 1.0);
    assert!(
        ratio(fwy, 2.0) > 2.0 * ratio(art, 2.0),
        "freeway x{:.2} vs arterial x{:.2}",
        ratio(fwy, 2.0),
        ratio(art, 2.0)
    );
    let slower = Calibration {
        class_speed: Some(JsObject(vec![("motorway".to_owned(), 0.5)])),
        ..Default::default()
    };
    let slow = Cal::new(Some(&slower), &g);
    assert!(running_time(fwy, 180.0, &slow, 1.0) > 1.9 * running_time(fwy, 180.0, &cal, 1.0));
    assert_eq!(
        running_time(art, 180.0, &slow, 1.0),
        running_time(art, 180.0, &cal, 1.0)
    );
}

// Per-stretch calibration.

fn stretch_cal(stretches: Vec<(&str, Stretch)>) -> Calibration {
    Calibration {
        stretches: Some(JsObject(
            stretches.into_iter().map(|(k, s)| (k.to_owned(), s)).collect(),
        )),
        ..Default::default()
    }
}

#[test]
fn a_stretchs_factors_change_its_own_edges_only_in_its_own_direction() {
    let g = plus(signal_centre());
    let (west, back, east) = (edge(&g, 100, 1), edge(&g, 100, 10), edge(&g, 101, 11));
    let calibration = stretch_cal(vec![(
        "s",
        Stretch {
            nodes: vec![10, 1],
            ways: vec![100],
            volume: 2.0,
            spread: 2.0,
        },
    )]);
    let cal = Cal::new(Some(&calibration), &g);
    let default = cal_of(&g);
    assert!(
        running_time(west, 480.0, &cal, 1.5) > running_time(west, 480.0, &default, 1.5),
        "busier on the stretch"
    );
    assert_eq!(edge_day_factor(west, &cal, 1.5), 1.5f64.powf(2.0));
    for e in [back, east] {
        assert_eq!(running_time(e, 480.0, &cal, 1.5), running_time(e, 480.0, &default, 1.5));
        assert_eq!(edge_day_factor(e, &cal, 1.5), 1.5);
    }
    // Its own approach to the light queues longer; the cross street's wait sees it as busier too.
    let mean = |in_edge: usize, out_edge: usize, c: &Cal| {
        let m = describe_movement(&g, in_edge, out_edge);
        let mut r = Rng::new(5);
        let mut s = 0.0;
        for _ in 0..400 {
            let ctx = DelayContext {
                minute_of_day: 480.0,
                day_factor: 1.5,
                cal: c,
            };
            s += sample_delay(&g, &m, &ctx, &mut r).seconds;
        }
        s / 400.0
    };
    assert!(
        mean(west.id, east.id, &cal) > mean(west.id, east.id, &default),
        "the stretch's own approach waits longer"
    );
}

#[test]
fn a_stretchs_factors_stay_on_its_own_road_where_another_road_joins_the_same_two_junctions() {
    // Birch Road and Cedar Way both run between the same two nodes.
    let g = build_graph(&road(vec![
        node(1, 0.0, 0.0),
        node(2, 0.0, D),
        node(3, D / 2.0, D / 2.0),
        way(7, &[1, 2], json!({ "highway": "tertiary", "name": "Birch Rd" })),
        way(8, &[1, 3, 2], json!({ "highway": "tertiary", "name": "Cedar Way" })),
    ]));
    let birch = g.edges.iter().find(|e| e.way == 7 && e.from_node == 1).unwrap();
    let cedar = g.edges.iter().find(|e| e.way == 8 && e.from_node == 1).unwrap();
    let calibration = stretch_cal(vec![(
        "s",
        Stretch {
            nodes: vec![1, 2],
            ways: vec![7],
            volume: 3.0,
            spread: 1.0,
        },
    )]);
    let cal = Cal::new(Some(&calibration), &g);
    let default = cal_of(&g);
    assert!(running_time(birch, 480.0, &cal, 1.5) > running_time(birch, 480.0, &default, 1.5));
    assert_eq!(
        running_time(cedar, 480.0, &cal, 1.5),
        running_time(cedar, 480.0, &default, 1.5)
    );
}

#[test]
fn the_leave_by_minute_meets_the_goal_on_its_own_simulation_at_every_confidence() {
    let g = plus(Extra::default());
    let cal = cal_of(&g);
    for confidence in [0.8, 0.9, 0.95, 0.99] {
        let o = PlanOptions {
            window_minutes: 20.0,
            step_minutes: 5.0,
            ..PlanOptions::new(goal(490.0, confidence), SimOptions::new(120, 3.0))
        };
        for c in plan(&g, &cal, &mut MovementStats::new(), vertex(&g, 10), vertex(&g, 21), &o) {
            let Some(lb) = c.leave_by else { continue };
            assert_eq!(lb, lb.floor(), "a whole minute");
            let on_time = c.leave_point.as_ref().unwrap().on_time;
            assert!(on_time >= confidence, "{on_time} at {confidence}");
        }
    }
}

#[test]
fn a_routes_leave_by_departure_is_simulated_at_the_minute_shown_its_chance_and_its_dots_agree() {
    let g = plus(Extra::default());
    let cal = cal_of(&g);
    let o = PlanOptions {
        window_minutes: 10.0,
        step_minutes: 5.0,
        ..PlanOptions::new(goal(490.0, 0.95), SimOptions::new(200, 1.0))
    };
    let choices = plan(&g, &cal, &mut MovementStats::new(), vertex(&g, 10), vertex(&g, 21), &o);
    let c = choices.first().expect("a route");
    assert!(c.leave_by.is_some() && c.leave_point.is_some());
    let p = c.leave_point.as_ref().unwrap();
    assert_eq!(p.depart_minute, c.leave_by.unwrap().floor());
    assert_eq!(c.at_leave_by.depart_minute, p.depart_minute);
    let on_time_dots = p.dots.iter().filter(|&&s| p.depart_minute + s / 60.0 <= 490.0).count();
    assert!(
        (on_time_dots as f64 / 20.0 - p.on_time).abs() <= 0.05 + 1e-9,
        "{on_time_dots} of 20 dots on time vs {}",
        p.on_time
    );
}

#[test]
fn a_new_route_mid_drive_starts_on_the_road_under_the_car_the_way_it_is_going_not_back_the_way_it_came() {
    let g = plus(Extra::default());
    let cal = cal_of(&g);
    let mut stats = MovementStats::new();
    let car = LatLon::new(0.00002, -D / 2.0); // on Main St, west of the junction
    let west = edge_under(&g, car, Some(270.0), 50.0);
    let east = edge_under(&g, car, Some(90.0), 50.0);
    assert_eq!(west, edge(&g, 100, 10).id as isize);
    assert_eq!(east, edge(&g, 100, 1).id as isize);
    assert_eq!(
        edge_under(&g, LatLon::new(0.01, 0.0), None, 50.0),
        -1,
        "no road within reach"
    );
    let north = vertex(&g, 20);
    let (west, east) = (west as usize, east as usize);
    let from = |start: usize| SearchOptions {
        start_edge: Some(start),
        ..SearchOptions::new(480.0, 0.0)
    };
    assert_eq!(
        shortest_path(&g, &cal, &mut stats, g.edges[west].from, north, &from(west)),
        None,
        "west is a dead end, and the router never turns back down a street"
    );
    let ahead = shortest_path(&g, &cal, &mut stats, g.edges[east].from, north, &from(east)).unwrap();
    assert_eq!(
        ahead.edges,
        vec![east, edge(&g, 200, 20).id],
        "heading east: straight on and left at the junction"
    );
}

// The control-placement rule is exported (placeControls) so anything that must agree with
// buildGraph asks the same question. The edge controls are those buildGraph gave before it
// was split out, on the same fixture.
#[test]
fn control_placement_build_graph_charges_each_tagged_control_where_place_controls_places_it() {
    const M: f64 = 1.0 / 111_195.0; // metres east (x) and north (y) of (0, 0)
    let n = |id: i64, x: f64, y: f64, tags: Option<Value>| nd(id, y * M, x * M, tags);
    let w = |id: i64, nodes: &[i64], highway: &str, extra: Value| {
        let mut tags = json!({ "highway": highway });
        if let (Some(t), Some(e)) = (tags.as_object_mut(), extra.as_object()) {
            t.extend(e.clone());
        }
        way(id, nodes, tags)
    };
    let data = road(vec![
        // Main Rd: an untagged signal 30 m before junction 3; an untagged stop 40 m past it (60 m
        // short of junction 6); a give-way tagged forward, 30 m before 6; a signal on 6.
        n(1, -200.0, 0.0, None),
        n(2, -30.0, 0.0, Some(json!({ "highway": "traffic_signals" }))),
        n(3, 0.0, 0.0, None),
        n(4, 40.0, 0.0, Some(json!({ "highway": "stop" }))),
        n(
            5,
            70.0,
            0.0,
            Some(json!({ "highway": "give_way", "direction": "forward" })),
        ),
        n(6, 100.0, 0.0, Some(json!({ "highway": "traffic_signals" }))),
        n(7, 300.0, 0.0, None),
        // Elm St through 3: a stop tagged backward, so toward 10, 180 m away: it governs nothing.
        n(10, 0.0, 200.0, None),
        n(
            11,
            0.0,
            20.0,
            Some(json!({ "highway": "stop", "direction": "backward" })),
        ),
        n(12, 0.0, -200.0, None),
        n(20, 100.0, -200.0, None),
        // A one-way street (against its node order) into 7, whose stop faces the way no car goes.
        n(30, 300.0, 200.0, None),
        n(31, 300.0, 30.0, Some(json!({ "highway": "stop" }))),
        w(100, &[1, 2, 3, 4, 5, 6, 7], "primary", json!({})),
        w(200, &[10, 11, 3, 12], "residential", json!({})),
        w(300, &[6, 20], "residential", json!({})),
        w(400, &[30, 31, 7], "residential", json!({ "oneway": "-1" })),
    ]);
    let g = build_graph(&data);
    let mut charged: Vec<String> = g
        .edges
        .iter()
        .filter(|e| e.control.is_some() && !e.control_inferred)
        .map(|e| {
            format!(
                "{} {}>{} {}",
                e.way,
                e.from_node,
                e.to_node,
                e.control.unwrap().as_str()
            )
        })
        .collect();
    charged.sort();
    assert_eq!(
        charged,
        [
            "100 1>3 signal",
            "100 3>6 signal",
            "100 6>3 stop",
            "100 7>6 signal",
            "300 20>6 signal"
        ]
    );
    let placed: BTreeSet<String> = place_controls(&data, &way_pieces(&data))
        .iter()
        .map(|p| {
            format!(
                "{} {}{} {}",
                p.way,
                if p.forward { "+" } else { "-" },
                p.at,
                p.control.as_str()
            )
        })
        .collect();
    assert_eq!(
        placed.into_iter().collect::<Vec<_>>(),
        [
            "100 +3 signal",
            "100 +6 give_way",
            "100 +6 signal",
            "100 -3 stop",
            "100 -6 signal",
            "300 -6 signal"
        ],
        "the give-way reaches 6 too, where the signal outranks it"
    );
}
