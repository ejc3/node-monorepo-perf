//! What the engine reads of `engine/src/osm.ts`: the class ranks, `streetKey`, and
//! `fromOverpass` (Overpass JSON to road data), which the unit tests build their small graphs with.

use serde_json::Value;

use crate::pack::{Control, ControlDirection, NodeRec, Restriction, RestrictionKind, RoadClass, RoadData, WayRec};

/// `CLASS_RANK`: higher is busier.
pub fn class_rank(c: RoadClass) -> f64 {
    match c {
        RoadClass::Motorway => 7.0,
        RoadClass::Trunk => 6.0,
        RoadClass::Primary => 5.0,
        RoadClass::Secondary => 4.0,
        RoadClass::Tertiary => 3.0,
        RoadClass::Unclassified => 2.0,
        RoadClass::Residential => 1.0,
        RoadClass::LivingStreet => 0.0,
    }
}

const STREET_SUFFIXES: &[&str] = &[
    "AV",
    "AVE",
    "AVENUE",
    "DR",
    "DRIVE",
    "ST",
    "STREET",
    "RD",
    "ROAD",
    "LN",
    "LANE",
    "WY",
    "WAY",
    "CT",
    "COURT",
    "BL",
    "BLVD",
    "BOULEVARD",
    "PL",
    "PLACE",
    "EX",
    "EXPY",
    "EXPRESSWAY",
    "CR",
    "CIR",
    "CIRCLE",
    "TER",
    "TERRACE",
    "PKWY",
    "PY",
    "PARKWAY",
    "HWY",
    "HIGHWAY",
    "LOOP",
    "SQ",
    "SQUARE",
    "TR",
    "TRL",
    "TRAIL",
];
const DIRECTIONS: [&str; 8] = ["N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST"];

/// `streetKey`: a street name reduced to what two sources agree on ("Oak Avenue" and
/// "OAK AV" are both "OAK"). Upper-cased, everything but A–Z, 0–9 and space read as a
/// space, leading compass words and trailing suffixes dropped while more than one word is left.
pub fn street_key(name: &str) -> String {
    let up = name.to_uppercase();
    let mapped: String = up
        .chars()
        .map(|c| {
            if c.is_ascii_uppercase() || c.is_ascii_digit() {
                c
            } else {
                ' '
            }
        })
        .collect();
    let mut words: Vec<&str> = mapped.split(' ').filter(|w| !w.is_empty()).collect();
    let mut start = 0;
    while words.len() - start > 1 && DIRECTIONS.contains(&words[start]) {
        start += 1;
    }
    let mut words = words.split_off(start);
    while words.len() > 1 && STREET_SUFFIXES.contains(words.last().expect("non-empty")) {
        words.pop();
    }
    words.join(" ")
}

const NOT_FOR_CARS: [&str; 7] = [
    "no",
    "private",
    "agricultural",
    "forestry",
    "delivery",
    "customers",
    "permit",
];

fn tag<'a>(tags: &'a Value, k: &str) -> Option<&'a str> {
    tags.get(k).and_then(Value::as_str)
}

/// `parseSpeed`: "25 mph", "40", "50 km/h".
fn parse_speed(v: Option<&str>) -> Option<f64> {
    let v = v?.trim();
    if v.is_empty() {
        return None;
    }
    let digits_end = v.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(v.len());
    let (num, rest) = v.split_at(digits_end);
    // ^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?$
    let mut parts = num.splitn(2, '.');
    let int = parts.next().unwrap_or("");
    let frac = parts.next();
    if int.is_empty() || frac.is_some_and(|f| f.is_empty() || f.contains('.')) {
        return None;
    }
    let unit = rest.trim_start();
    let n: f64 = num.parse().ok()?;
    match unit {
        "" | "km/h" | "kmh" => Some(n),
        "mph" => Some(n * 1.609344),
        _ => None,
    }
}

fn parse_oneway(tags: &Value, cls: RoadClass, roundabout: bool) -> Option<i8> {
    let v = tag(tags, "oneway:motor_vehicle").or_else(|| tag(tags, "oneway"));
    match v {
        Some("yes" | "1" | "true") => Some(1),
        Some("-1" | "reverse") => Some(-1),
        Some("reversible" | "alternating") => None,
        Some("no" | "0" | "false") => Some(0),
        _ => Some(if cls == RoadClass::Motorway || roundabout { 1 } else { 0 }),
    }
}

/// `controlOf`.
pub fn control_of(tags: Option<&Value>) -> (Option<Control>, Option<ControlDirection>) {
    let Some(t) = tags else { return (None, None) };
    let dir = |v: Option<&str>| match v {
        Some("forward") => Some(ControlDirection::Forward),
        Some("backward") => Some(ControlDirection::Backward),
        Some("both") => Some(ControlDirection::Both),
        _ => None,
    };
    let direction = |k: &str| dir(tag(t, k).or_else(|| tag(t, "direction")));
    match tag(t, "highway") {
        Some("traffic_signals") => (Some(Control::Signal), direction("traffic_signals:direction")),
        Some("stop") => (
            Some(if tag(t, "stop") == Some("all") {
                Control::AllWayStop
            } else {
                Control::Stop
            }),
            direction("stop:direction"),
        ),
        Some("give_way") => (Some(Control::GiveWay), direction("give_way:direction")),
        Some("mini_roundabout") => (Some(Control::MiniRoundabout), None),
        _ => (None, None),
    }
}

/// `fromOverpass`: Overpass JSON elements to road data, keeping only ways a car may drive and
/// the nodes they use.
pub fn from_overpass(elements: &[Value]) -> RoadData {
    let num = |v: &Value| v.as_f64();
    let mut ways = Vec::new();
    for e in elements {
        let (Some("way"), Some(t), Some(nodes)) = (
            e.get("type").and_then(Value::as_str),
            e.get("tags").filter(|t| t.is_object()),
            e.get("nodes").and_then(Value::as_array),
        ) else {
            continue;
        };
        if nodes.len() < 2 {
            continue;
        }
        let hw = tag(t, "highway").unwrap_or("");
        let link = hw.ends_with("_link");
        let Some(cls) = RoadClass::parse(if link { &hw[..hw.len() - 5] } else { hw }) else {
            continue;
        };
        let access = tag(t, "motorcar")
            .or_else(|| tag(t, "motor_vehicle"))
            .or_else(|| tag(t, "vehicle"))
            .or_else(|| tag(t, "access"));
        if access.is_some_and(|a| NOT_FOR_CARS.contains(&a)) {
            continue;
        }
        let roundabout = tag(t, "junction") == Some("roundabout");
        let Some(oneway) = parse_oneway(t, cls, roundabout || tag(t, "junction") == Some("circular")) else {
            continue;
        };
        let lanes = tag(t, "lanes").and_then(|l| {
            // Number.parseInt(l, 10): leading space, an optional sign, then digits.
            let l = l.trim_start();
            let l = l.strip_prefix('+').unwrap_or(l);
            let d: String = l.chars().take_while(char::is_ascii_digit).collect();
            d.parse::<f64>().ok().filter(|n| *n > 0.0)
        });
        ways.push(WayRec {
            id: num(&e["id"]).unwrap_or(0.0) as i64,
            cls,
            link,
            name: tag(t, "name").or_else(|| tag(t, "ref")).unwrap_or("").to_owned(),
            oneway,
            lanes,
            maxspeed_kph: parse_speed(tag(t, "maxspeed")),
            roundabout,
            destination_only: access == Some("destination"),
            nodes: nodes.iter().filter_map(num).map(|n| n as i64).collect(),
        });
    }
    let used: std::collections::HashSet<i64> = ways.iter().flat_map(|w| w.nodes.iter().copied()).collect();
    let mut nodes = Vec::new();
    for e in elements {
        if e.get("type").and_then(Value::as_str) != Some("node") {
            continue;
        }
        let id = num(&e["id"]).unwrap_or(0.0) as i64;
        let (Some(lat), Some(lon)) = (e.get("lat").and_then(num), e.get("lon").and_then(num)) else {
            continue;
        };
        if !used.contains(&id) {
            continue;
        }
        let (control, control_direction) = control_of(e.get("tags"));
        nodes.push(NodeRec {
            id,
            lat,
            lon,
            control,
            control_direction,
        });
    }
    let mut restrictions = Vec::new();
    for e in elements {
        let (Some("relation"), Some(t), Some(members)) = (
            e.get("type").and_then(Value::as_str),
            e.get("tags"),
            e.get("members").and_then(Value::as_array),
        ) else {
            continue;
        };
        if tag(t, "type") != Some("restriction") {
            continue;
        }
        let r = tag(t, "restriction:motorcar")
            .or_else(|| tag(t, "restriction"))
            .unwrap_or("");
        if tag(t, "except").is_some_and(|x| x.contains("motorcar")) {
            continue;
        }
        fn role(m: &Value, r: &str) -> bool {
            m.get("role").and_then(Value::as_str) == Some(r)
        }
        fn mtype(m: &Value) -> Option<&str> {
            m.get("type").and_then(Value::as_str)
        }
        let from = members.iter().find(|m| role(m, "from") && mtype(m) == Some("way"));
        let via: Vec<&Value> = members.iter().filter(|m| role(m, "via")).collect();
        let to = members.iter().find(|m| role(m, "to") && mtype(m) == Some("way"));
        let (Some(from), Some(to)) = (from, to) else { continue };
        if via.len() != 1 || mtype(via[0]) != Some("node") {
            continue;
        }
        let kind = if r.starts_with("no_") {
            RestrictionKind::No
        } else if r.starts_with("only_") {
            RestrictionKind::Only
        } else {
            continue;
        };
        let rf = |m: &Value| num(&m["ref"]).unwrap_or(0.0) as i64;
        restrictions.push(Restriction {
            from_way: rf(from),
            via_node: rf(via[0]),
            to_way: rf(to),
            kind,
        });
    }
    RoadData {
        ways,
        nodes,
        restrictions,
        control_points: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn street_names_from_two_sources_agree() {
        assert_eq!(street_key("Oak Avenue"), "OAK");
        assert_eq!(street_key("OAK AV"), "OAK");
        assert_eq!(street_key("North 1st Street"), "1ST");
        assert_eq!(street_key("Avenue"), "AVENUE");
        assert_eq!(street_key("W San Carlos St"), "SAN CARLOS");
        assert_eq!(street_key("O'Brien Ct"), "O BRIEN");
        assert_eq!(street_key(""), "");
    }

    #[test]
    fn speeds_parse_as_osm_writes_them() {
        assert_eq!(parse_speed(Some("40")), Some(40.0));
        assert_eq!(parse_speed(Some("25 mph")), Some(25.0 * 1.609344));
        assert_eq!(parse_speed(Some("50 km/h")), Some(50.0));
        assert_eq!(parse_speed(Some("signals")), None);
        assert_eq!(parse_speed(Some("5.")), None);
        assert_eq!(parse_speed(None), None);
    }
}
