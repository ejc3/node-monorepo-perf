# The area pack

`san-jose-menlo-park.pack.json.br` is the bench's map: the drivable roads of the San José–Menlo
Park corridor (south 37.24, west -122.23, north 37.50, east -121.86) from OpenStreetMap, as of
the `osmTimestamp` inside it (2026-10-20T22:30:37Z), Brotli-compressed. Decompressed it is one
JSON object, the engine's `AreaPack` (`route-planner/engine/src/pack.ts`): the ways (class, link,
name, one-way, lanes, speed limit, roundabout, access=destination, node ids), the nodes
(position, and a signal, stop, give-way or mini-roundabout tag with its direction) and the turn
restrictions. It holds no calibration: the engine runs on `DEFAULT_CALIBRATION`.

It was extracted from the Overpass API: every `highway` way of the classes in `osm.ts`
(motorway to living street, with their links) in the box, the nodes they reference, and the
`type=restriction` relations on them; read by `fromOverpass` (`osm.ts`, which keeps the ways a
car may use), kept as CSV with speed limits to 0.1 km/h, and packed by `toPack` (`pack.ts`,
which rounds them to whole km/h).

## Licence

Map data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0:
https://www.openstreetmap.org/copyright and https://opendatacommons.org/licenses/odbl/1-0/.
The pack is a derived database and is under the ODbL; the code in this repository is under its
MIT licence (`LICENSE`).
