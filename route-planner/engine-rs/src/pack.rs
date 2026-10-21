//! An area pack (`engine/src/pack.ts`'s `AreaPack`) decoded into the records `fromPack` gives,
//! with the pack's meta and calibration beside them.
//!
//! The data is the TypeScript decoder's, value for value: coordinates are the pack's integers
//! divided by 1e7 (one IEEE division, as in JavaScript), and every map the engine iterates keeps
//! JavaScript's property order. Where `fromPack` would carry a malformed value on (an unknown
//! control index, a flat array cut short), decoding fails instead, with the place named.

use std::collections::HashMap;
use std::fmt;

use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};

use crate::jsnum::{is_array_index, json_number, json_string_into, to_int32};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoadClass {
    Motorway,
    Trunk,
    Primary,
    Secondary,
    Tertiary,
    Unclassified,
    Residential,
    LivingStreet,
}

impl RoadClass {
    /// `ROAD_CLASSES`, in its order.
    pub const ALL: [RoadClass; 8] = [
        RoadClass::Motorway,
        RoadClass::Trunk,
        RoadClass::Primary,
        RoadClass::Secondary,
        RoadClass::Tertiary,
        RoadClass::Unclassified,
        RoadClass::Residential,
        RoadClass::LivingStreet,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            RoadClass::Motorway => "motorway",
            RoadClass::Trunk => "trunk",
            RoadClass::Primary => "primary",
            RoadClass::Secondary => "secondary",
            RoadClass::Tertiary => "tertiary",
            RoadClass::Unclassified => "unclassified",
            RoadClass::Residential => "residential",
            RoadClass::LivingStreet => "living_street",
        }
    }

    pub fn parse(s: &str) -> Option<RoadClass> {
        RoadClass::ALL.into_iter().find(|c| c.as_str() == s)
    }
}

/// `Control`, in pack.ts's `CONTROLS` order (a node's pack index is this order's + 1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Control {
    Signal,
    Stop,
    AllWayStop,
    GiveWay,
    MiniRoundabout,
}

impl Control {
    pub const PACK_ORDER: [Control; 5] = [
        Control::Signal,
        Control::Stop,
        Control::AllWayStop,
        Control::GiveWay,
        Control::MiniRoundabout,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Control::Signal => "signal",
            Control::Stop => "stop",
            Control::AllWayStop => "all_way_stop",
            Control::GiveWay => "give_way",
            Control::MiniRoundabout => "mini_roundabout",
        }
    }
}

/// `ControlDirection` without its null, in pack.ts's `DIRECTIONS` order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlDirection {
    Forward,
    Backward,
    Both,
}

impl ControlDirection {
    pub const PACK_ORDER: [ControlDirection; 3] = [
        ControlDirection::Forward,
        ControlDirection::Backward,
        ControlDirection::Both,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ControlDirection::Forward => "forward",
            ControlDirection::Backward => "backward",
            ControlDirection::Both => "both",
        }
    }
}

/// `SurveyedControl`, in pack.ts's `SURVEYED` order (the pack index is this order's).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurveyedControl {
    None,
    Stop,
    AllWayStop,
    Signal,
    GiveWay,
}

impl SurveyedControl {
    pub const PACK_ORDER: [SurveyedControl; 5] = [
        SurveyedControl::None,
        SurveyedControl::Stop,
        SurveyedControl::AllWayStop,
        SurveyedControl::Signal,
        SurveyedControl::GiveWay,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SurveyedControl::None => "none",
            SurveyedControl::Stop => "stop",
            SurveyedControl::AllWayStop => "all_way_stop",
            SurveyedControl::Signal => "signal",
            SurveyedControl::GiveWay => "give_way",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestrictionKind {
    No,
    Only,
}

impl RestrictionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RestrictionKind::No => "no",
            RestrictionKind::Only => "only",
        }
    }
}

/// `WayRec`.
#[derive(Clone, Debug, PartialEq)]
pub struct WayRec {
    pub id: i64,
    pub cls: RoadClass,
    pub link: bool,
    pub name: String,
    pub oneway: i8,
    pub lanes: Option<f64>,
    pub maxspeed_kph: Option<f64>,
    pub roundabout: bool,
    pub destination_only: bool,
    pub nodes: Vec<i64>,
}

/// `NodeRec`.
#[derive(Clone, Debug, PartialEq)]
pub struct NodeRec {
    pub id: i64,
    pub lat: f64,
    pub lon: f64,
    pub control: Option<Control>,
    pub control_direction: Option<ControlDirection>,
}

/// `Restriction`.
#[derive(Clone, Debug, PartialEq)]
pub struct Restriction {
    pub from_way: i64,
    pub via_node: i64,
    pub to_way: i64,
    pub kind: RestrictionKind,
}

/// `ControlPoint`.
#[derive(Clone, Debug, PartialEq)]
pub struct ControlPoint {
    pub lat: f64,
    pub lon: f64,
    pub control: SurveyedControl,
    pub streets: Vec<String>,
}

/// `RoadData`: what `fromPack` returns.
#[derive(Clone, Debug, PartialEq)]
pub struct RoadData {
    pub ways: Vec<WayRec>,
    pub nodes: Vec<NodeRec>,
    pub restrictions: Vec<Restriction>,
    pub control_points: Option<Vec<ControlPoint>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct BBox {
    pub south: f64,
    pub west: f64,
    pub north: f64,
    pub east: f64,
}

/// A JSON object as JavaScript holds it after `JSON.parse`: array-index keys first, ascending,
/// then the rest in the text's order; a repeated key keeps its first place and its last value.
/// `Object.keys`, `Object.values`, `for…in` and `JSON.stringify` all walk it in this order.
#[derive(Clone, Debug, PartialEq)]
pub struct JsObject<V>(pub Vec<(String, V)>);

impl<V> JsObject<V> {
    pub fn get(&self, key: &str) -> Option<&V> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v))
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Entries in source order (duplicates already folded) into JavaScript's property order.
    pub fn from_source_order(entries: Vec<(String, V)>) -> Self {
        let (mut index, rest): (Vec<_>, Vec<_>) = entries.into_iter().partition(|(k, _)| is_array_index(k));
        index.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(0));
        index.extend(rest);
        JsObject(index)
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for JsObject<V> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V_<V>(std::marker::PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for V_<V> {
            type Value = JsObject<V>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Self::Value, A::Error> {
                let mut entries: Vec<(String, V)> = Vec::new();
                let mut at: HashMap<String, usize> = HashMap::new();
                while let Some((k, v)) = m.next_entry::<String, V>()? {
                    match at.get(&k) {
                        Some(&i) => entries[i].1 = v,
                        None => {
                            at.insert(k.clone(), entries.len());
                            entries.push((k, v));
                        }
                    }
                }
                Ok(JsObject::from_source_order(entries))
            }
        }
        d.deserialize_map(V_(std::marker::PhantomData))
    }
}

/// `Stretch`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Stretch {
    #[serde(deserialize_with = "ids")]
    pub nodes: Vec<i64>,
    #[serde(deserialize_with = "ids")]
    pub ways: Vec<i64>,
    pub volume: f64,
    pub spread: f64,
}

/// A pack's `calibration`: `Partial<Calibration>`, each field present or not. A field that is
/// present must have a value: TypeScript's `{ ...DEFAULT_CALIBRATION, ...cal }` would let a null
/// replace the default, so a null is refused rather than read as absent.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    #[serde(default, deserialize_with = "present")]
    pub volume_scale: Option<f64>,
    #[serde(default, deserialize_with = "present")]
    pub speed_scale: Option<f64>,
    #[serde(default, deserialize_with = "present")]
    pub day_sigma: Option<f64>,
    #[serde(default, deserialize_with = "present")]
    pub edge_sigma: Option<f64>,
    #[serde(default, deserialize_with = "present")]
    pub peak_exponent: Option<f64>,
    #[serde(default, deserialize_with = "present")]
    pub left_turn_share: Option<f64>,
    #[serde(default, deserialize_with = "present")]
    pub class_volume: Option<JsObject<f64>>,
    #[serde(default, deserialize_with = "present")]
    pub class_speed: Option<JsObject<f64>>,
    #[serde(default, deserialize_with = "present")]
    pub way_volume: Option<JsObject<f64>>,
    #[serde(default, deserialize_with = "present")]
    pub stretches: Option<JsObject<Stretch>>,
}

impl Calibration {
    /// The calibration as JSON, fields in `Calibration`'s declared order, absent ones left out,
    /// maps in JavaScript's order and numbers spelled as `JSON.stringify` spells them. The
    /// harness builds the same text from the TypeScript side.
    pub fn canonical_json(&self) -> String {
        let mut o = String::from("{");
        let mut first = true;
        let mut key = |o: &mut String, k: &str| {
            if !first {
                o.push(',');
            }
            first = false;
            json_string_into(o, k);
            o.push(':');
        };
        let nums = [
            ("volumeScale", self.volume_scale),
            ("speedScale", self.speed_scale),
            ("daySigma", self.day_sigma),
            ("edgeSigma", self.edge_sigma),
            ("peakExponent", self.peak_exponent),
            ("leftTurnShare", self.left_turn_share),
        ];
        for (k, v) in nums {
            if let Some(v) = v {
                key(&mut o, k);
                o.push_str(&json_number(v));
            }
        }
        let maps = [
            ("classVolume", &self.class_volume),
            ("classSpeed", &self.class_speed),
            ("wayVolume", &self.way_volume),
        ];
        for (k, m) in maps {
            if let Some(m) = m {
                key(&mut o, k);
                write_object(&mut o, m, |o, v| o.push_str(&json_number(*v)));
            }
        }
        if let Some(s) = &self.stretches {
            key(&mut o, "stretches");
            write_object(&mut o, s, |o, s| {
                o.push_str("{\"nodes\":");
                write_ids(o, &s.nodes);
                o.push_str(",\"ways\":");
                write_ids(o, &s.ways);
                o.push_str(",\"volume\":");
                o.push_str(&json_number(s.volume));
                o.push_str(",\"spread\":");
                o.push_str(&json_number(s.spread));
                o.push('}');
            });
        }
        o.push('}');
        o
    }
}

fn write_object<V>(o: &mut String, m: &JsObject<V>, mut value: impl FnMut(&mut String, &V)) {
    o.push('{');
    for (i, (k, v)) in m.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        json_string_into(o, k);
        o.push(':');
        value(o, v);
    }
    o.push('}');
}

fn write_ids(o: &mut String, ids: &[i64]) {
    o.push('[');
    for (i, id) in ids.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str(&id.to_string());
    }
    o.push(']');
}

/// A decoded area pack.
#[derive(Clone, Debug, PartialEq)]
pub struct AreaPack {
    pub id: String,
    pub name: String,
    pub bbox: BBox,
    pub osm_timestamp: String,
    pub calibration: Option<Calibration>,
    pub names: Vec<String>,
    pub data: RoadData,
}

#[derive(Debug)]
pub struct PackError(pub String);

impl fmt::Display for PackError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "area pack: {}", self.0)
    }
}

impl std::error::Error for PackError {}

fn err<T>(msg: impl Into<String>) -> Result<T, PackError> {
    Err(PackError(msg.into()))
}

/// The largest integer a double holds exactly, and so the largest id a pack can carry.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

fn id_of(x: f64) -> Option<i64> {
    (x.fract() == 0.0 && x.abs() <= MAX_SAFE).then_some(x as i64)
}

/// A field that, when present, must not be null.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

fn ids<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<i64>, D::Error> {
    Vec::<f64>::deserialize(d)?
        .into_iter()
        .map(|x| id_of(x).ok_or_else(|| de::Error::custom(format!("{x} is not an integer id"))))
        .collect()
}

/// One row of `ways`: `[id, cls, link, name index, oneway, lanes|0, maxspeed|0, flags, ...nodes]`.
struct WayRow {
    id: f64,
    cls: String,
    link: f64,
    name: f64,
    oneway: f64,
    lanes: f64,
    maxspeed: f64,
    flags: f64,
    nodes: Vec<f64>,
}

impl<'de> Deserialize<'de> for WayRow {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = WayRow;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a way row [id, cls, link, name, oneway, lanes, maxspeed, flags, ...nodes]")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<WayRow, A::Error> {
                let short = || de::Error::custom("a way row has fewer than 8 fields");
                let id = s.next_element()?.ok_or_else(short)?;
                let cls = s.next_element()?.ok_or_else(short)?;
                let link = s.next_element()?.ok_or_else(short)?;
                let name = s.next_element()?.ok_or_else(short)?;
                let oneway = s.next_element()?.ok_or_else(short)?;
                let lanes = s.next_element()?.ok_or_else(short)?;
                let maxspeed = s.next_element()?.ok_or_else(short)?;
                let flags = s.next_element()?.ok_or_else(short)?;
                let mut nodes = Vec::with_capacity(s.size_hint().unwrap_or(4));
                while let Some(n) = s.next_element()? {
                    nodes.push(n);
                }
                Ok(WayRow {
                    id,
                    cls,
                    link,
                    name,
                    oneway,
                    lanes,
                    maxspeed,
                    flags,
                    nodes,
                })
            }
        }
        d.deserialize_seq(V)
    }
}

/// One row of `controlPoints`: `[lat*1e7, lon*1e7, control index, ...street keys]`.
struct ControlPointRow {
    lat: f64,
    lon: f64,
    control: f64,
    streets: Vec<String>,
}

impl<'de> Deserialize<'de> for ControlPointRow {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = ControlPointRow;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a control point row [lat, lon, control, ...streets]")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<ControlPointRow, A::Error> {
                let short = || de::Error::custom("a control point row has fewer than 3 fields");
                let lat = s.next_element()?.ok_or_else(short)?;
                let lon = s.next_element()?.ok_or_else(short)?;
                let control = s.next_element()?.ok_or_else(short)?;
                let mut streets = Vec::new();
                while let Some(st) = s.next_element()? {
                    streets.push(st);
                }
                Ok(ControlPointRow {
                    lat,
                    lon,
                    control,
                    streets,
                })
            }
        }
        d.deserialize_seq(V)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackJson {
    v: f64,
    id: String,
    name: String,
    bbox: BBox,
    osm_timestamp: String,
    calibration: Option<Calibration>,
    ways: Vec<WayRow>,
    names: Vec<String>,
    nodes: Vec<f64>,
    restrictions: Vec<f64>,
    control_points: Option<Vec<ControlPointRow>>,
}

/// JavaScript's truthiness for a number: not 0, -0 or NaN.
fn truthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

/// `x || null` for a number.
fn or_null(x: f64) -> Option<f64> {
    truthy(x).then_some(x)
}

/// `TABLE[i - 1]` for a nonzero pack index, `null` for 0.
fn indexed<T: Copy>(table: &[T], i: f64, what: &str, at: usize) -> Result<Option<T>, PackError> {
    if i == 0.0 {
        return Ok(None);
    }
    match id_of(i)
        .and_then(|i| usize::try_from(i - 1).ok())
        .and_then(|i| table.get(i))
    {
        Some(t) => Ok(Some(*t)),
        None => err(format!("node {at}: {what} index {i} is out of range")),
    }
}

fn need_id(x: f64, what: &str) -> Result<i64, PackError> {
    match id_of(x) {
        Some(v) => Ok(v),
        None => err(format!("{what}: {x} is not an integer id")),
    }
}

/// Decodes a pack's JSON text: `fromPack(JSON.parse(text))`, with its meta and calibration.
pub fn decode(json: &[u8]) -> Result<AreaPack, PackError> {
    let p: PackJson = serde_json::from_slice(json).map_err(|e| PackError(e.to_string()))?;
    if p.v != 1.0 {
        return err(format!("version {} (this engine reads 1)", p.v));
    }
    let mut ways = Vec::with_capacity(p.ways.len());
    for (i, w) in p.ways.into_iter().enumerate() {
        let Some(cls) = RoadClass::parse(&w.cls) else {
            return err(format!("way {i}: unknown class {:?}", w.cls));
        };
        let oneway: i8 = if w.oneway == 1.0 {
            1
        } else if w.oneway == 0.0 {
            0
        } else if w.oneway == -1.0 {
            -1
        } else {
            return err(format!("way {i}: oneway {}", w.oneway));
        };
        // `p.names[w[3]] ?? ""`: an index outside the table is an empty name.
        let name = id_of(w.name)
            .and_then(|n| usize::try_from(n).ok())
            .and_then(|n| p.names.get(n))
            .cloned()
            .unwrap_or_default();
        let flags = to_int32(w.flags);
        ways.push(WayRec {
            id: need_id(w.id, "way id")?,
            cls,
            link: w.link == 1.0,
            name,
            oneway,
            lanes: or_null(w.lanes),
            maxspeed_kph: or_null(w.maxspeed),
            roundabout: flags & 1 != 0,
            destination_only: flags & 2 != 0,
            nodes: w
                .nodes
                .into_iter()
                .map(|n| need_id(n, "way node"))
                .collect::<Result<_, _>>()?,
        });
    }
    if !p.nodes.len().is_multiple_of(5) {
        return err(format!("nodes has {} numbers, not a multiple of 5", p.nodes.len()));
    }
    let mut nodes = Vec::with_capacity(p.nodes.len() / 5);
    for (i, n) in p.nodes.chunks_exact(5).enumerate() {
        nodes.push(NodeRec {
            id: need_id(n[0], "node id")?,
            lat: n[1] / 1e7,
            lon: n[2] / 1e7,
            control: indexed(&Control::PACK_ORDER, n[3], "control", i)?,
            control_direction: indexed(&ControlDirection::PACK_ORDER, n[4], "direction", i)?,
        });
    }
    if !p.restrictions.len().is_multiple_of(4) {
        return err(format!(
            "restrictions has {} numbers, not a multiple of 4",
            p.restrictions.len()
        ));
    }
    let restrictions = p
        .restrictions
        .chunks_exact(4)
        .map(|r| {
            Ok(Restriction {
                from_way: need_id(r[0], "restriction fromWay")?,
                via_node: need_id(r[1], "restriction viaNode")?,
                to_way: need_id(r[2], "restriction toWay")?,
                kind: if truthy(r[3]) {
                    RestrictionKind::Only
                } else {
                    RestrictionKind::No
                },
            })
        })
        .collect::<Result<_, PackError>>()?;
    let control_points = match p.control_points {
        None => None,
        Some(rows) => Some(
            rows.into_iter()
                .enumerate()
                .map(|(i, c)| {
                    let control = id_of(c.control)
                        .and_then(|k| usize::try_from(k).ok())
                        .and_then(|k| SurveyedControl::PACK_ORDER.get(k).copied());
                    let Some(control) = control else {
                        return err(format!("control point {i}: control {}", c.control));
                    };
                    Ok(ControlPoint {
                        lat: c.lat / 1e7,
                        lon: c.lon / 1e7,
                        control,
                        streets: c.streets,
                    })
                })
                .collect::<Result<_, _>>()?,
        ),
    };
    Ok(AreaPack {
        id: p.id,
        name: p.name,
        bbox: p.bbox,
        osm_timestamp: p.osm_timestamp,
        calibration: p.calibration,
        names: p.names,
        data: RoadData {
            ways,
            nodes,
            restrictions,
            control_points,
        },
    })
}

/// How much a pack holds, for the harness.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub ways: usize,
    pub way_nodes: usize,
    pub names: usize,
    pub nodes: usize,
    pub controlled_nodes: usize,
    pub restrictions: usize,
    pub control_points: Option<usize>,
    pub stretches: usize,
}

impl AreaPack {
    pub fn counts(&self) -> Counts {
        let d = &self.data;
        Counts {
            ways: d.ways.len(),
            way_nodes: d.ways.iter().map(|w| w.nodes.len()).sum(),
            names: self.names.len(),
            nodes: d.nodes.len(),
            controlled_nodes: d.nodes.iter().filter(|n| n.control.is_some()).count(),
            restrictions: d.restrictions.len(),
            control_points: d.control_points.as_ref().map(Vec::len),
            stretches: self
                .calibration
                .as_ref()
                .and_then(|c| c.stretches.as_ref())
                .map_or(0, JsObject::len),
        }
    }

    /// The decoded records as bytes, in a layout the harness writes the same way from
    /// `fromPack`'s output: equal bytes, equal data. Little-endian; every number is the f64 the
    /// TypeScript record holds (ids too), a string is its UTF-8 length (u32) and bytes, a null
    /// is the empty string (classes, controls) or a 0/1 flag before the number (lanes, maxspeed).
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let d = &self.data;
        let mut b = Bytes(Vec::with_capacity(64 + d.nodes.len() * 40 + d.ways.len() * 64));
        b.raw(b"route-planner pack v1\n");
        b.str(&self.id);
        b.str(&self.name);
        for x in [self.bbox.south, self.bbox.west, self.bbox.north, self.bbox.east] {
            b.f64(x);
        }
        b.str(&self.osm_timestamp);
        b.len(d.ways.len());
        for w in &d.ways {
            b.f64(w.id as f64);
            b.str(w.cls.as_str());
            b.flag(w.link);
            b.str(&w.name);
            b.f64(f64::from(w.oneway));
            b.opt(w.lanes);
            b.opt(w.maxspeed_kph);
            b.flag(w.roundabout);
            b.flag(w.destination_only);
            b.len(w.nodes.len());
            for &n in &w.nodes {
                b.f64(n as f64);
            }
        }
        b.len(d.nodes.len());
        for n in &d.nodes {
            b.f64(n.id as f64);
            b.f64(n.lat);
            b.f64(n.lon);
            b.str(n.control.map_or("", Control::as_str));
            b.str(n.control_direction.map_or("", ControlDirection::as_str));
        }
        b.len(d.restrictions.len());
        for r in &d.restrictions {
            b.f64(r.from_way as f64);
            b.f64(r.via_node as f64);
            b.f64(r.to_way as f64);
            b.str(r.kind.as_str());
        }
        match &d.control_points {
            None => b.flag(false),
            Some(cps) => {
                b.flag(true);
                b.len(cps.len());
                for c in cps {
                    b.f64(c.lat);
                    b.f64(c.lon);
                    b.str(c.control.as_str());
                    b.len(c.streets.len());
                    for s in &c.streets {
                        b.str(s);
                    }
                }
            }
        }
        b.0
    }
}

struct Bytes(Vec<u8>);

impl Bytes {
    fn raw(&mut self, x: &[u8]) {
        self.0.extend_from_slice(x);
    }
    fn f64(&mut self, x: f64) {
        self.raw(&x.to_le_bytes());
    }
    fn len(&mut self, n: usize) {
        self.raw(&u32::try_from(n).expect("fewer than 2^32 records").to_le_bytes());
    }
    fn str(&mut self, s: &str) {
        self.len(s.len());
        self.raw(s.as_bytes());
    }
    fn flag(&mut self, x: bool) {
        self.0.push(u8::from(x));
    }
    fn opt(&mut self, x: Option<f64>) {
        match x {
            None => self.flag(false),
            Some(v) => {
                self.flag(true);
                self.f64(v);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PACK: &str = r#"{"v":1,"id":"plus","name":"Plus","bbox":{"south":0,"west":-1,"north":1,"east":1},
        "osmTimestamp":"2026-01-01T00:00:00Z",
        "calibration":{"volumeScale":1.25,"wayVolume":{"x":1,"10":2,"9":3,"01":4,"4294967295":5,"4294967294":6,"x":7},
          "stretches":{"b":{"nodes":[1,2],"ways":[100],"volume":1.5,"spread":0.5},"7":{"nodes":[2,1],"ways":[100],"volume":1,"spread":1}}},
        "names":["Main St","Elm St"],
        "ways":[[100,"primary",0,0,0,4,56,0,10,1,11],[200,"residential_link",1,1,1,0,0,3,20,1],[300,"motorway",1,9,-1,2,0,2]],
        "nodes":[1,0,0,1,3, 10,0,-18000,0,0, 11,0,18000,5,1, 20,18000,0,0,0, 13456789012,374545012,-1221823456,0,0],
        "restrictions":[100,1,200,0, 200,1,100,1],
        "controlPoints":[[374545012,-1221823456,3,"MAIN","ELM"]]}"#;

    #[test]
    fn decodes_what_from_pack_gives() {
        let p = decode(PACK.replace("residential_link", "residential").as_bytes()).unwrap();
        let w = &p.data.ways;
        assert_eq!(w.len(), 3);
        assert_eq!(
            (w[0].id, w[0].cls, w[0].link, w[0].name.as_str()),
            (100, RoadClass::Primary, false, "Main St")
        );
        assert_eq!(
            (w[0].lanes, w[0].maxspeed_kph, w[0].nodes.clone()),
            (Some(4.0), Some(56.0), vec![10, 1, 11])
        );
        assert_eq!(
            (w[1].link, w[1].oneway, w[1].lanes, w[1].maxspeed_kph),
            (true, 1, None, None)
        );
        assert_eq!((w[1].roundabout, w[1].destination_only), (true, true));
        // A name index past the table is "", as `?? ""` makes it.
        assert_eq!((w[2].name.as_str(), w[2].oneway, w[2].nodes.len()), ("", -1, 0));
        assert_eq!((w[2].roundabout, w[2].destination_only), (false, true));
        let n = &p.data.nodes;
        assert_eq!(
            (n[0].control, n[0].control_direction),
            (Some(Control::Signal), Some(ControlDirection::Both))
        );
        assert_eq!(
            (n[2].control, n[2].control_direction),
            (Some(Control::MiniRoundabout), Some(ControlDirection::Forward))
        );
        assert_eq!(n[1].lon.to_bits(), (-18000f64 / 1e7).to_bits());
        assert_eq!(
            (n[4].id, n[4].lat, n[4].lon),
            (13_456_789_012, 37.4545012, -122.1823456)
        );
        assert_eq!(p.data.restrictions[0].kind, RestrictionKind::No);
        assert_eq!(p.data.restrictions[1].kind, RestrictionKind::Only);
        let cp = &p.data.control_points.as_ref().unwrap()[0];
        assert_eq!(
            (cp.control, cp.streets.clone()),
            (SurveyedControl::Signal, vec!["MAIN".to_owned(), "ELM".to_owned()])
        );
        assert_eq!(p.counts().stretches, 2);
    }

    #[test]
    fn calibration_maps_keep_javascripts_property_order() {
        let p = decode(PACK.replace("residential_link", "residential").as_bytes()).unwrap();
        let cal = p.calibration.unwrap();
        // JSON.stringify(JSON.parse(...)) of the same text, from node.
        assert_eq!(
            cal.canonical_json(),
            r#"{"volumeScale":1.25,"wayVolume":{"9":3,"10":2,"4294967294":6,"x":7,"01":4,"4294967295":5},"stretches":{"7":{"nodes":[2,1],"ways":[100],"volume":1,"spread":1},"b":{"nodes":[1,2],"ways":[100],"volume":1.5,"spread":0.5}}}"#
        );
    }

    #[test]
    fn refuses_what_from_pack_would_carry_on_malformed() {
        let e = decode(PACK.as_bytes()).unwrap_err().to_string();
        assert!(e.contains("unknown class \"residential_link\""), "{e}");
        let fixed = PACK.replace("residential_link", "residential");
        let e = decode(fixed.replace("11,0,18000,5,1", "11,0,18000,6,1").as_bytes())
            .unwrap_err()
            .to_string();
        assert!(e.contains("control index 6"), "{e}");
        let e = decode(fixed.replace("200,1,100,1]", "200,1,100]").as_bytes())
            .unwrap_err()
            .to_string();
        assert!(e.contains("not a multiple of 4"), "{e}");
        let e = decode(fixed.replace("\"v\":1", "\"v\":2").as_bytes())
            .unwrap_err()
            .to_string();
        assert!(e.contains("version 2"), "{e}");
    }

    #[test]
    fn a_null_calibration_field_is_refused_not_read_as_absent() {
        // `{ ...DEFAULT_CALIBRATION, ...cal }` lets a null override the default; None would not.
        let fixed = PACK.replace("residential_link", "residential");
        for field in ["\"volumeScale\":null", "\"wayVolume\":null"] {
            let text = fixed.replacen("\"volumeScale\":1.25", field, 1);
            let e = decode(text.as_bytes()).unwrap_err().to_string();
            assert!(e.contains("null"), "{field}: {e}");
        }
    }

    #[test]
    fn a_pack_without_calibration_or_control_points() {
        let p = decode(br#"{"v":1,"id":"a","name":"A","bbox":{"south":0,"west":0,"north":0,"east":0},"osmTimestamp":"","calibration":null,"ways":[],"names":[],"nodes":[],"restrictions":[]}"#).unwrap();
        assert!(p.calibration.is_none() && p.data.control_points.is_none());
        assert_eq!(p.canonical_bytes().last(), Some(&0));
    }
}
