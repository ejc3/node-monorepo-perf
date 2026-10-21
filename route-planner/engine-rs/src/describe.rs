//! `engine/src/describe.ts`: the roads a route is named by, and its line.

use std::cmp::Ordering;

use crate::fxhash::FxHashMap;
use crate::graph::Graph;
use crate::router::Route;
use crate::text::short;

/// `viaNames`: the named roads a route spends the most distance on, in order of travel.
pub fn via_names(g: &Graph, route: &Route, max: usize) -> Vec<String> {
    // name → (length, first edge index), in first-seen order.
    let mut by_name: Vec<(&str, f64, usize)> = Vec::new();
    let mut at: FxHashMap<&str, usize> = FxHashMap::default();
    for (i, &ei) in route.edges.iter().enumerate() {
        let e = &g.edges[ei];
        if e.name.is_empty() {
            continue;
        }
        let k = *at.entry(e.name.as_str()).or_insert_with(|| {
            by_name.push((e.name.as_str(), 0.0, i));
            by_name.len() - 1
        });
        by_name[k].1 += e.length_m;
    }
    by_name.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
    by_name.truncate(max);
    by_name.sort_by(|a, b| a.2.cmp(&b.2));
    by_name.into_iter().map(|(n, _, _)| short(n)).collect()
}

/// `routeLine`: the route's line, [lon, lat], for a map.
pub fn route_line(g: &Graph, route: &Route) -> Vec<[f64; 2]> {
    let mut out: Vec<[f64; 2]> = Vec::new();
    for &ei in &route.edges {
        let geom = &g.edges[ei].geometry;
        let from = if out.is_empty() { 0 } else { 1 };
        for p in geom.iter().skip(from) {
            out.push([p.lon, p.lat]);
        }
    }
    out
}
