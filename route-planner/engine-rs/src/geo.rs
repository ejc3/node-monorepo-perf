//! `engine/src/geo.ts`: distances, bearings and projections, in the TypeScript's arithmetic order.

use crate::jsmath::{asin, atan2, cos, js_max, js_min, js_pow, js_rem, sin, sqrt, PI};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LatLon {
    pub lat: f64,
    pub lon: f64,
}

impl LatLon {
    pub const fn new(lat: f64, lon: f64) -> Self {
        LatLon { lat, lon }
    }
}

const R: f64 = 6371008.8;

#[inline]
fn rad(d: f64) -> f64 {
    (d * PI) / 180.0
}

/// Great-circle distance in metres.
pub fn distance(a: LatLon, b: LatLon) -> f64 {
    let d_lat = rad(b.lat - a.lat);
    let d_lon = rad(b.lon - a.lon);
    let h = js_pow(sin(d_lat / 2.0), 2.0) + cos(rad(a.lat)) * cos(rad(b.lat)) * js_pow(sin(d_lon / 2.0), 2.0);
    2.0 * R * asin(js_min(1.0, sqrt(h)))
}

/// Initial bearing from a to b, degrees clockwise from north in [0, 360).
pub fn bearing(a: LatLon, b: LatLon) -> f64 {
    let y = sin(rad(b.lon - a.lon)) * cos(rad(b.lat));
    let x = cos(rad(a.lat)) * sin(rad(b.lat)) - sin(rad(a.lat)) * cos(rad(b.lat)) * cos(rad(b.lon - a.lon));
    js_rem((atan2(y, x) * 180.0) / PI + 360.0, 360.0)
}

/// Signed change of heading from `in_bearing` to `out_bearing`, in (-180, 180]. Positive turns right.
pub fn turn_angle(in_bearing: f64, out_bearing: f64) -> f64 {
    let mut d = js_rem(out_bearing - in_bearing, 360.0);
    if d > 180.0 {
        d -= 360.0;
    }
    if d <= -180.0 {
        d += 360.0;
    }
    d
}

/// Projection of p onto segment ab in a local equirectangular frame: the fraction along it
/// (`t`) and the distance off it.
#[derive(Clone, Copy, Debug)]
pub struct Projection {
    pub t: f64,
    pub distance: f64,
}

pub fn project_on_segment(p: LatLon, a: LatLon, b: LatLon) -> Projection {
    let k = cos(rad((a.lat + b.lat) / 2.0));
    let (ax, ay, bx, by, px, py) = (a.lon * k, a.lat, b.lon * k, b.lat, p.lon * k, p.lat);
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        js_max(0.0, js_min(1.0, ((px - ax) * dx + (py - ay) * dy) / len2))
    };
    Projection {
        t,
        distance: distance(p, LatLon::new(a.lat + t * (b.lat - a.lat), a.lon + t * (b.lon - a.lon))),
    }
}

pub fn interpolate(a: LatLon, b: LatLon, t: f64) -> LatLon {
    LatLon::new(a.lat + t * (b.lat - a.lat), a.lon + t * (b.lon - a.lon))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_angles_are_in_minus_180_to_180() {
        assert_eq!(turn_angle(350.0, 10.0), 20.0);
        assert_eq!(turn_angle(10.0, 350.0), -20.0);
        assert_eq!(turn_angle(0.0, 180.0), 180.0);
        assert_eq!(turn_angle(180.0, 0.0), 180.0);
    }

    #[test]
    fn a_degree_of_latitude_is_about_111_km() {
        let d = distance(LatLon::new(0.0, 0.0), LatLon::new(1.0, 0.0));
        assert!((d - 111_195.0).abs() < 5.0, "{d}");
        assert_eq!(bearing(LatLon::new(0.0, 0.0), LatLon::new(1.0, 0.0)), 0.0);
        assert!((bearing(LatLon::new(0.0, 0.0), LatLon::new(0.0, 1.0)) - 90.0).abs() < 1e-9);
    }

    #[test]
    fn a_projection_is_clamped_to_the_segment() {
        let (a, b) = (LatLon::new(0.0, 0.0), LatLon::new(0.0, 0.001));
        assert_eq!(project_on_segment(LatLon::new(0.0, -0.001), a, b).t, 0.0);
        assert_eq!(project_on_segment(LatLon::new(0.0, 0.002), a, b).t, 1.0);
        let mid = project_on_segment(LatLon::new(0.0001, 0.0005), a, b);
        assert!((mid.t - 0.5).abs() < 1e-9 && (mid.distance - 11.12).abs() < 0.05);
    }
}
