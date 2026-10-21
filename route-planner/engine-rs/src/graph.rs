//! `engine/src/graph.ts`: road data to a graph of vertices, directed edges and intersection
//! complexes, with the control each approach meets and the turn restrictions.
//!
//! Vertex ids, edge ids, adjacency lists and complex ids are made in the TypeScript order, so
//! every search and every tie breaks the same way.

use std::collections::HashSet;

use crate::fxhash::{FxHashMap, FxHashSet};
use crate::geo::{bearing, distance, project_on_segment, turn_angle, LatLon};
use crate::jsmath::{abs, js_round};
use crate::jsnum::to_fixed;
use crate::osm::{class_rank, street_key};
use crate::pack::{Control, ControlDirection, NodeRec, RestrictionKind, RoadClass, RoadData, SurveyedControl, WayRec};

#[derive(Clone, Debug)]
pub struct Edge {
    pub id: usize,
    pub from: usize,
    pub to: usize,
    /// OSM node ids of `from` and `to`: what a calibration's stretches name.
    pub from_node: i64,
    pub to_node: i64,
    pub way: i64,
    pub cls: RoadClass,
    pub link: bool,
    pub name: String,
    pub lanes: Option<f64>,
    /// The OSM way is one-way (its `lanes` are all this edge's).
    pub oneway: bool,
    pub roundabout: bool,
    pub length_m: f64,
    pub free_speed_kph: f64,
    pub start_bearing: f64,
    pub end_bearing: f64,
    pub geometry: Vec<LatLon>,
    /// Control met on arrival at `to`.
    pub control: Option<Control>,
    /// True when no tag said so: the control was inferred from the classes meeting.
    pub control_inferred: bool,
    pub destination_only: bool,
}

#[derive(Clone, Debug)]
pub struct Vertex {
    pub node: i64,
    pub lat: f64,
    pub lon: f64,
    pub out: Vec<usize>,
    pub inc: Vec<usize>,
    /// Distinct physical directions; 3+ is a junction.
    pub degree: usize,
    pub complex: usize,
}

impl Vertex {
    #[inline]
    pub fn ll(&self) -> LatLon {
        LatLon::new(self.lat, self.lon)
    }
}

#[derive(Clone, Debug)]
pub struct Complex {
    pub id: usize,
    pub vertices: Vec<usize>,
    /// Highest class rank of any way meeting here.
    pub major_rank: f64,
    /// Names of the busiest roads meeting here, for explanations.
    pub major_name: String,
    pub signalized: bool,
    pub all_way: bool,
    /// What a survey says governs this intersection, when one covers it.
    pub surveyed: Option<SurveyedControl>,
}

#[derive(Clone, Debug)]
pub struct TurnRestriction {
    pub kind: RestrictionKind,
    pub to_ways: FxHashSet<i64>,
}

#[derive(Clone, Debug)]
pub struct Graph {
    pub vertices: Vec<Vertex>,
    pub edges: Vec<Edge>,
    pub complexes: Vec<Complex>,
    pub vertex_of_node: FxHashMap<i64, usize>,
    /// (fromWay, viaNode) → restriction.
    pub restrictions: FxHashMap<(i64, i64), TurnRestriction>,
}

fn default_speed_kph(c: RoadClass) -> f64 {
    match c {
        RoadClass::Motorway => 105.0,
        RoadClass::Trunk => 80.0,
        RoadClass::Primary => 64.0,
        RoadClass::Secondary => 56.0,
        RoadClass::Tertiary => 48.0,
        RoadClass::Unclassified => 40.0,
        RoadClass::Residential => 40.0,
        RoadClass::LivingStreet => 15.0,
    }
}

/// `roadRank`: how busy a road ranks at a junction; a ramp ranks just above a residential street.
#[inline]
pub fn road_rank(cls: RoadClass, link: bool) -> f64 {
    if link {
        1.5
    } else {
        class_rank(cls)
    }
}

#[inline]
pub fn edge_rank(e: &Edge) -> f64 {
    road_rank(e.cls, e.link)
}

/// A stop or signal tag up to this far before a junction governs it.
pub const CONTROL_REACH_M: f64 = 60.0;
const SURVEY_REACH_M: f64 = 35.0;
const COMPLEX_LINK_M: f64 = 30.0;

fn end_bearing(points: &[LatLon], from_end: bool) -> f64 {
    // Measure over ~20 m so a kink in the last metre does not decide the turn.
    let n = points.len();
    let at = |i: usize| if from_end { points[n - 1 - i] } else { points[i] };
    let a = at(0);
    let mut b = at(1);
    let mut acc = 0.0;
    for i in 1..n {
        acc += distance(at(i - 1), at(i));
        b = at(i);
        if acc >= 20.0 {
            break;
        }
    }
    if from_end {
        bearing(b, a)
    } else {
        bearing(a, b)
    }
}

/// A way's run between two vertices, by index into its nodes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WayPiece {
    pub start_idx: usize,
    pub end_idx: usize,
    pub length_m: f64,
}

fn ll(n: &NodeRec) -> LatLon {
    LatLon::new(n.lat, n.lon)
}

/// `new Map(data.nodes.map((n) => [n.id, n]))`: a repeated id keeps its last record.
fn node_map(data: &RoadData) -> FxHashMap<i64, &NodeRec> {
    let mut m = FxHashMap::with_capacity_and_hasher(data.nodes.len(), Default::default());
    for n in &data.nodes {
        m.insert(n.id, n);
    }
    m
}

/// `wayPieces`: each way cut at its vertices (a way end, or a node shared by ways). A way with
/// a node the data does not hold has no entry; a closed run under a metre long is no piece.
pub fn way_pieces(data: &RoadData) -> FxHashMap<i64, Vec<WayPiece>> {
    let nodes = node_map(data);
    way_pieces_with(data, &nodes)
}

fn way_pieces_with(data: &RoadData, nodes: &FxHashMap<i64, &NodeRec>) -> FxHashMap<i64, Vec<WayPiece>> {
    let mut uses: FxHashMap<i64, u64> = FxHashMap::default();
    for w in &data.ways {
        let last = w.nodes.len().wrapping_sub(1);
        for (i, n) in w.nodes.iter().enumerate() {
            let end = i == 0 || i == last;
            *uses.entry(*n).or_insert(0) += if end { 1 } else { 2 };
        }
    }
    let is_vertex =
        |n: i64, i: usize, w: &WayRec| i == 0 || i == w.nodes.len() - 1 || uses.get(&n).copied().unwrap_or(0) > 2;
    let mut out = FxHashMap::default();
    for w in &data.ways {
        if !w.nodes.iter().all(|n| nodes.contains_key(n)) {
            continue;
        }
        let mut pieces = Vec::new();
        let mut start = 0;
        for i in 1..w.nodes.len() {
            if !is_vertex(w.nodes[i], i, w) {
                continue;
            }
            let mut length_m = 0.0;
            for k in start + 1..=i {
                length_m += distance(ll(nodes[&w.nodes[k - 1]]), ll(nodes[&w.nodes[k]]));
            }
            if !(w.nodes[start] == w.nodes[i] && length_m < 1.0) {
                pieces.push(WayPiece {
                    start_idx: start,
                    end_idx: i,
                    length_m,
                });
            }
            start = i;
        }
        out.insert(w.id, pieces);
    }
    out
}

/// `ControlPlacement`: a tagged control carried to an approach it governs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ControlPlacement {
    pub way: i64,
    pub piece: usize,
    pub forward: bool,
    pub at: i64,
    pub control: Control,
    pub node: i64,
}

/// `placeControls`: which approaches each tagged signal, stop, give-way or mini-roundabout governs.
pub fn place_controls(data: &RoadData, pieces: &FxHashMap<i64, Vec<WayPiece>>) -> Vec<ControlPlacement> {
    let nodes = node_map(data);
    place_controls_with(data, pieces, &nodes)
}

fn place_controls_with(
    data: &RoadData,
    pieces: &FxHashMap<i64, Vec<WayPiece>>,
    nodes: &FxHashMap<i64, &NodeRec>,
) -> Vec<ControlPlacement> {
    let mut out = Vec::new();
    let dist = |w: &WayRec, j: usize| distance(ll(nodes[&w.nodes[j]]), ll(nodes[&w.nodes[j + 1]]));
    for w in &data.ways {
        let Some(ps) = pieces.get(&w.id) else { continue };
        let place = |out: &mut Vec<ControlPlacement>, piece: usize, forward: bool, control: Control, node: i64| {
            if w.oneway == (if forward { -1 } else { 1 }) {
                return;
            }
            let p = ps[piece];
            out.push(ControlPlacement {
                way: w.id,
                piece,
                forward,
                at: w.nodes[if forward { p.end_idx } else { p.start_idx }],
                control,
                node,
            });
        };
        for (idx, &node_id) in w.nodes.iter().enumerate() {
            let Some(n) = nodes.get(&node_id) else { continue };
            let Some(control) = n.control else { continue };
            for (k, p) in ps.iter().enumerate() {
                if idx < p.start_idx || idx > p.end_idx {
                    continue;
                }
                let mut to_end = 0.0;
                for j in idx..p.end_idx {
                    to_end += dist(w, j);
                }
                let mut to_start = 0.0;
                for j in p.start_idx..idx {
                    to_start += dist(w, j);
                }
                let dir = n.control_direction;
                let at_vertex = idx == p.start_idx || idx == p.end_idx;
                if at_vertex && dir.is_none() && control != Control::Stop && control != Control::GiveWay {
                    // A signal or all-way stop on the junction node: every approach on this way.
                    if idx == p.end_idx {
                        place(&mut out, k, true, control, node_id);
                    }
                    if idx == p.start_idx {
                        place(&mut out, k, false, control, node_id);
                    }
                    continue;
                }
                let forward = matches!(dir, Some(ControlDirection::Forward | ControlDirection::Both))
                    || (dir.is_none() && to_end <= to_start);
                let backward = matches!(dir, Some(ControlDirection::Backward | ControlDirection::Both))
                    || (dir.is_none() && to_start < to_end);
                if forward && to_end <= CONTROL_REACH_M && idx != p.start_idx {
                    place(&mut out, k, true, control, node_id);
                }
                if backward && to_start <= CONTROL_REACH_M && idx != p.end_idx {
                    place(&mut out, k, false, control, node_id);
                }
                if control == Control::Signal && dir.is_none() && !at_vertex {
                    // An untagged-direction signal before a junction governs both directions through it.
                    if to_end <= CONTROL_REACH_M {
                        place(&mut out, k, true, Control::Signal, node_id);
                    }
                    if to_start <= CONTROL_REACH_M {
                        place(&mut out, k, false, Control::Signal, node_id);
                    }
                }
            }
        }
    }
    out
}

/// Rank of a control when two tags reach one approach: a signal outranks a stop outranks a yield.
fn control_order(c: Control) -> usize {
    match c {
        Control::GiveWay => 0,
        Control::MiniRoundabout => 1,
        Control::Stop => 2,
        Control::AllWayStop => 3,
        Control::Signal => 4,
    }
}

fn strength(c: SurveyedControl) -> usize {
    match c {
        SurveyedControl::None => 0,
        SurveyedControl::GiveWay => 1,
        SurveyedControl::Stop => 2,
        SurveyedControl::AllWayStop => 3,
        SurveyedControl::Signal => 4,
    }
}

/// A way piece's edge in node order and against it (None where the way is one-way).
type PieceEdges = (Option<usize>, Option<usize>);

pub fn build_graph(data: &RoadData) -> Graph {
    let nodes = node_map(data);
    let mut vertices: Vec<Vertex> = Vec::new();
    let mut vertex_of_node: FxHashMap<i64, usize> = FxHashMap::default();
    let mut vertex_for = |vertices: &mut Vec<Vertex>, id: i64| -> usize {
        if let Some(&v) = vertex_of_node.get(&id) {
            return v;
        }
        let n = nodes[&id];
        let v = vertices.len();
        vertices.push(Vertex {
            node: id,
            lat: n.lat,
            lon: n.lon,
            out: Vec::new(),
            inc: Vec::new(),
            degree: 0,
            complex: usize::MAX,
        });
        vertex_of_node.insert(id, v);
        v
    };

    let mut edges: Vec<Edge> = Vec::new();
    let pieces = way_pieces_with(data, &nodes);
    // Each piece's edge in node order and against it (None where the way is one-way).
    let mut edges_of_way: FxHashMap<i64, Vec<PieceEdges>> = FxHashMap::default();
    let mut neighbours: FxHashMap<usize, FxHashSet<i64>> = FxHashMap::default();

    for w in &data.ways {
        let Some(ps) = pieces.get(&w.id) else { continue };
        // A way's first node is a vertex even when its only piece is too short to keep.
        if w.nodes.len() > 1 {
            vertex_for(&mut vertices, w.nodes[0]);
        }
        let mut made = Vec::with_capacity(ps.len());
        for p in ps {
            let (start, i, length_m) = (p.start_idx, p.end_idx, p.length_m);
            let ids = &w.nodes[start..=i];
            let geometry: Vec<LatLon> = ids.iter().map(|id| ll(nodes[id])).collect();
            let a = vertex_for(&mut vertices, ids[0]);
            let b = vertex_for(&mut vertices, ids[ids.len() - 1]);
            let speed = w
                .maxspeed_kph
                .unwrap_or_else(|| default_speed_kph(w.cls) * if w.link { 0.75 } else { 1.0 });
            let mut make = |vertices: &mut Vec<Vertex>, from: usize, to: usize, geom: Vec<LatLon>| -> usize {
                let id = edges.len();
                edges.push(Edge {
                    id,
                    from,
                    to,
                    from_node: vertices[from].node,
                    to_node: vertices[to].node,
                    way: w.id,
                    cls: w.cls,
                    link: w.link,
                    name: w.name.clone(),
                    lanes: w.lanes,
                    oneway: w.oneway != 0,
                    roundabout: w.roundabout,
                    length_m,
                    free_speed_kph: speed,
                    start_bearing: end_bearing(&geom, false),
                    end_bearing: end_bearing(&geom, true),
                    geometry: geom,
                    control: None,
                    control_inferred: false,
                    destination_only: w.destination_only,
                });
                vertices[from].out.push(id);
                vertices[to].inc.push(id);
                id
            };
            let fwd = if w.oneway == -1 {
                None
            } else {
                Some(make(&mut vertices, a, b, geometry.clone()))
            };
            let bwd = if w.oneway == 1 {
                None
            } else {
                let mut rev = geometry;
                rev.reverse();
                Some(make(&mut vertices, b, a, rev))
            };
            made.push((fwd, bwd));
            // Direction keyed by the neighbouring node id, so a two-way street counts once.
            neighbours.entry(a).or_default().insert(w.nodes[start + 1]);
            neighbours.entry(b).or_default().insert(w.nodes[i - 1]);
        }
        edges_of_way.insert(w.id, made);
    }
    for (v, set) in &neighbours {
        vertices[*v].degree = set.len();
    }

    // Controls: each tagged node on the approaches it governs; the stronger control holds.
    for p in place_controls_with(data, &pieces, &nodes) {
        let made = edges_of_way[&p.way][p.piece];
        let ei = (if p.forward { made.0 } else { made.1 }).expect("a placement only goes the ways a car may travel");
        let e = &mut edges[ei];
        if e.control.is_none_or(|c| control_order(p.control) > control_order(c)) {
            e.control = Some(p.control);
        }
    }

    // Complexes: union junction vertices joined by a short edge.
    let mut parent: Vec<usize> = (0..vertices.len()).collect();
    fn find(parent: &mut [usize], i: usize) -> usize {
        let mut r = i;
        while parent[r] != r {
            r = parent[r];
        }
        let mut j = i;
        while parent[j] != r {
            let next = parent[j];
            parent[j] = r;
            j = next;
        }
        r
    }
    for e in &edges {
        if e.length_m <= COMPLEX_LINK_M && vertices[e.from].degree >= 3 && vertices[e.to].degree >= 3 {
            let a = find(&mut parent, e.from);
            let b = find(&mut parent, e.to);
            parent[a] = b;
        }
    }
    let mut complex_of_root: FxHashMap<usize, usize> = FxHashMap::default();
    let mut complexes: Vec<Complex> = Vec::new();
    for (i, v) in vertices.iter_mut().enumerate() {
        let r = find(&mut parent, i);
        let c = *complex_of_root.entry(r).or_insert_with(|| {
            let c = complexes.len();
            complexes.push(Complex {
                id: c,
                vertices: Vec::new(),
                major_rank: -1.0,
                major_name: String::new(),
                signalized: false,
                all_way: false,
                surveyed: None,
            });
            c
        });
        v.complex = c;
        complexes[c].vertices.push(i);
    }
    for e in &edges {
        for vi in [e.from, e.to] {
            let c = &mut complexes[vertices[vi].complex];
            let rank = edge_rank(e);
            if rank > c.major_rank {
                c.major_rank = rank;
                c.major_name = e.name.clone();
            } else if rank == c.major_rank
                && !e.name.is_empty()
                && !c.major_name.split(" / ").any(|n| n == e.name)
                && c.major_name.split(" / ").count() < 2
            {
                c.major_name = if c.major_name.is_empty() {
                    e.name.clone()
                } else {
                    format!("{} / {}", c.major_name, e.name)
                };
            }
        }
        if e.control == Some(Control::Signal) {
            complexes[vertices[e.to].complex].signalized = true;
        }
        if e.control == Some(Control::AllWayStop) {
            complexes[vertices[e.to].complex].all_way = true;
        }
    }

    let mut g = Graph {
        vertices,
        edges,
        complexes,
        vertex_of_node,
        restrictions: FxHashMap::default(),
    };

    let mut complex_has_freeway = vec![false; g.complexes.len()];
    for e in &g.edges {
        if !e.link && (e.cls == RoadClass::Motorway || e.cls == RoadClass::Trunk) {
            complex_has_freeway[g.vertices[e.to].complex] = true;
        }
    }

    // Surveyed controls: each point to the junction that names the most of its streets, then
    // the nearest. Two surveys landing on one intersection: the stronger control holds.
    if let Some(points) = &data.control_points {
        let cell = |x: f64| js_round(x * 500.0) as i64; // ~200 m cells; -0 and 0 are one cell, as "-0" is "0"
        let mut junctions_by_cell: FxHashMap<(i64, i64), Vec<usize>> = FxHashMap::default();
        for (i, v) in g.vertices.iter().enumerate() {
            if v.degree < 3 {
                continue;
            }
            junctions_by_cell.entry((cell(v.lat), cell(v.lon))).or_default().push(i);
        }
        for p in points {
            let (mut best, mut best_score, mut best_d) = (usize::MAX, 0usize, f64::INFINITY);
            let (la, lo) = (cell(p.lat), cell(p.lon));
            let pll = LatLon::new(p.lat, p.lon);
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let Some(list) = junctions_by_cell.get(&(la + dy, lo + dx)) else {
                        continue;
                    };
                    for &vi in list {
                        let d = distance(pll, g.vertices[vi].ll());
                        if d > SURVEY_REACH_M {
                            continue;
                        }
                        let here = streets_at(&g, vi);
                        let score = p.streets.iter().filter(|s| here.contains(s.as_str())).count();
                        if score > best_score || (score == best_score && score > 0 && d < best_d) {
                            best = vi;
                            best_score = score;
                            best_d = d;
                        }
                    }
                }
            }
            if best == usize::MAX {
                continue;
            }
            let c = &mut g.complexes[g.vertices[best].complex];
            if c.surveyed.is_none_or(|s| strength(p.control) > strength(s)) {
                c.surveyed = Some(p.control);
            }
        }
    }

    // Untagged approaches into a junction: a survey says, or infer and say so.
    let osm_control: Vec<Option<Control>> = g.edges.iter().map(|e| e.control).collect();
    for ei in 0..g.edges.len() {
        let decided = infer_control(&g, ei, &osm_control, &complex_has_freeway);
        if let Some((control, inferred)) = decided {
            let e = &mut g.edges[ei];
            e.control = Some(control);
            e.control_inferred = inferred;
        }
    }

    let mut restrictions: FxHashMap<(i64, i64), TurnRestriction> = FxHashMap::default();
    for r in &data.restrictions {
        // An "only" onto a road this extract does not hold would forbid every way out: dropped.
        if r.kind == RestrictionKind::Only {
            let ok = g
                .vertex_of_node
                .get(&r.via_node)
                .is_some_and(|&v| g.vertices[v].out.iter().any(|&e| g.edges[e].way == r.to_way));
            if !ok {
                continue;
            }
        }
        let key = (r.from_way, r.via_node);
        match restrictions.get_mut(&key) {
            Some(cur) if cur.kind == r.kind => {
                cur.to_ways.insert(r.to_way);
            }
            cur if cur.is_none() || r.kind == RestrictionKind::Only => {
                let mut to_ways = FxHashSet::default();
                to_ways.insert(r.to_way);
                restrictions.insert(key, TurnRestriction { kind: r.kind, to_ways });
            }
            _ => {}
        }
    }
    g.restrictions = restrictions;
    g
}

fn streets_at(g: &Graph, vi: usize) -> HashSet<String> {
    let v = &g.vertices[vi];
    v.inc
        .iter()
        .chain(v.out.iter())
        .map(|&ei| street_key(&g.edges[ei].name))
        .collect()
}

/// The control an untagged approach gets (and whether it was inferred), or None to leave it.
fn infer_control(
    g: &Graph,
    ei: usize,
    osm_control: &[Option<Control>],
    complex_has_freeway: &[bool],
) -> Option<(Control, bool)> {
    let e = &g.edges[ei];
    if e.control.is_some() {
        return None;
    }
    let to = &g.vertices[e.to];
    if to.degree < 3 {
        return None;
    }
    // Entering a roundabout: yield to the traffic already circulating.
    if !e.roundabout && to.out.iter().any(|&o| g.edges[o].roundabout) {
        return Some((Control::GiveWay, true));
    }
    let from = &g.vertices[e.from];
    if from.complex == to.complex {
        return None; // inside an intersection: charged on entry
    }
    let c = &g.complexes[to.complex];
    if let Some(s) = c.surveyed {
        return match s {
            SurveyedControl::Signal => Some((Control::Signal, false)),
            SurveyedControl::AllWayStop => Some((Control::AllWayStop, false)),
            SurveyedControl::Stop | SurveyedControl::GiveWay => {
                let (governed, assumed) = side_street(g, c.id, e, osm_control);
                governed.then(|| {
                    let control = if s == SurveyedControl::Stop {
                        Control::Stop
                    } else {
                        Control::GiveWay
                    };
                    (control, assumed)
                })
            }
            SurveyedControl::None => None,
        };
    }
    if c.signalized {
        return Some((Control::Signal, true));
    }
    if c.all_way {
        return Some((Control::AllWayStop, true));
    }
    let rank = edge_rank(e);
    // A ramp onto a freeway or expressway merges in its own lane: no control.
    if e.link && complex_has_freeway[to.complex] {
        return None;
    }
    if rank < c.major_rank {
        // US convention: the lesser road stops; a ramp onto a surface street yields.
        return Some((if e.link { Control::GiveWay } else { Control::Stop }, true));
    }
    None
}

/// `armKey`: a two-way arm by the first point of road beyond the junction, a one-way carriageway
/// by the vertex it comes from or goes to.
fn arm_key(e: &Edge, arriving: bool) -> String {
    if e.oneway {
        return format!("v{}", if arriving { e.from } else { e.to });
    }
    let p = if arriving {
        e.geometry[e.geometry.len() - 2]
    } else {
        e.geometry[1]
    };
    format!("{},{}", to_fixed(p.lat, 7), to_fixed(p.lon, 7))
}

/// `carriesOn`: two or more of the street's physical arms meet the intersection.
fn carries_on(g: &Graph, cx: usize, key: &str) -> bool {
    if key.is_empty() {
        return false;
    }
    let mut arms: HashSet<String> = HashSet::new();
    for &vi in &g.complexes[cx].vertices {
        for &ai in &g.vertices[vi].inc {
            let a = &g.edges[ai];
            if g.vertices[a.from].complex != cx && street_key(&a.name) == key {
                arms.insert(arm_key(a, true));
            }
        }
        for &ai in &g.vertices[vi].out {
            let a = &g.edges[ai];
            if g.vertices[a.to].complex != cx && street_key(&a.name) == key {
                arms.insert(arm_key(a, false));
            }
        }
    }
    arms.len() >= 2
}

/// `sideStreet`: whether a surveyed side-street stop or yield governs approach `e` (and whether
/// that is assumed).
fn side_street(g: &Graph, cx: usize, e: &Edge, osm_control: &[Option<Control>]) -> (bool, bool) {
    let c = &g.complexes[cx];
    if edge_rank(e) < c.major_rank {
        return (true, false);
    }
    let key = street_key(&e.name);
    if !carries_on(g, cx, &key) {
        return (true, false);
    }
    let mut contenders: HashSet<String> = HashSet::new();
    contenders.insert(key.clone());
    for &vi in &c.vertices {
        for &ai in &g.vertices[vi].inc {
            let a = &g.edges[ai];
            let k = street_key(&a.name);
            if g.vertices[a.from].complex != cx && edge_rank(a) == c.major_rank && carries_on(g, cx, &k) {
                contenders.insert(k);
            }
        }
    }
    if contenders.len() == 1 {
        return (false, false);
    }
    let mut signed: HashSet<String> = HashSet::new();
    for &vi in &c.vertices {
        for &ai in &g.vertices[vi].inc {
            let a = &g.edges[ai];
            let k = street_key(&a.name);
            let sign = osm_control[ai];
            if g.vertices[a.from].complex != cx
                && contenders.contains(&k)
                && matches!(sign, Some(Control::Stop | Control::GiveWay))
            {
                signed.insert(k);
            }
        }
    }
    if !signed.is_empty() {
        return (signed.contains(&key), false);
    }
    (true, true)
}

/// `movementAllowed`: may a vehicle on `in_edge` continue onto `out_edge`?
pub fn movement_allowed(g: &Graph, in_edge: &Edge, out_edge: &Edge) -> bool {
    let v = &g.vertices[in_edge.to];
    if out_edge.from != in_edge.to {
        return false;
    }
    // No U-turn back down the same piece, not even at a dead end.
    if out_edge.to == in_edge.from && out_edge.way == in_edge.way {
        return false;
    }
    let Some(r) = g.restrictions.get(&(in_edge.way, v.node)) else {
        return true;
    };
    if r.kind == RestrictionKind::Only {
        return r.to_ways.contains(&out_edge.way);
    }
    if !r.to_ways.contains(&out_edge.way) {
        return true;
    }
    // A "no" whose from and to are the same way (no_u_turn) forbids turning back along it.
    if out_edge.way == in_edge.way {
        return abs(turn_angle(in_edge.end_bearing, out_edge.start_bearing)) <= 150.0;
    }
    false
}

/// `edgeUnder`: the nearest edge within `max_m` whose direction agrees with the heading (within
/// 60°); with no heading, the nearest edge. -1 when no road is that near.
pub fn edge_under(g: &Graph, p: LatLon, heading_deg: Option<f64>, max_m: f64) -> isize {
    let (mut best, mut best_d) = (-1isize, f64::INFINITY);
    for (i, e) in g.edges.iter().enumerate() {
        for k in 1..e.geometry.len() {
            let (a, b) = (e.geometry[k - 1], e.geometry[k]);
            let d = project_on_segment(p, a, b).distance;
            if d > max_m || d >= best_d {
                continue;
            }
            if let Some(h) = heading_deg {
                if abs(turn_angle(bearing(a, b), h)) > 60.0 {
                    continue;
                }
            }
            best_d = d;
            best = i as isize;
        }
    }
    best
}

/// `nearestVertex`: the nearer end of the nearest road a car can use (not a freeway or ramp);
/// -1 when the graph has none.
pub fn nearest_vertex(g: &Graph, p: LatLon) -> isize {
    let (mut best_edge, mut best_d) = (usize::MAX, f64::INFINITY);
    for (i, e) in g.edges.iter().enumerate() {
        if e.cls == RoadClass::Motorway || e.cls == RoadClass::Trunk || e.link {
            continue;
        }
        for k in 1..e.geometry.len() {
            let d = project_on_segment(p, e.geometry[k - 1], e.geometry[k]).distance;
            if d < best_d {
                best_d = d;
                best_edge = i;
            }
        }
    }
    if best_edge == usize::MAX {
        return -1;
    }
    let e = &g.edges[best_edge];
    let usable = |vi: usize| !g.vertices[vi].out.is_empty() && !g.vertices[vi].inc.is_empty();
    let (a, b) = (e.from, e.to);
    if !usable(a) {
        return b as isize;
    }
    if !usable(b) {
        return a as isize;
    }
    if distance(p, g.vertices[a].ll()) <= distance(p, g.vertices[b].ll()) {
        a as isize
    } else {
        b as isize
    }
}
