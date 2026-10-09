import { padStart } from "lodash-es";
import type { NamePool } from "./types";
import type { Rng } from "./rng";

const FIRST = [
  "Avery",
  "Jordan",
  "Priya",
  "Mateo",
  "Hana",
  "Lukas",
  "Amara",
  "Diego",
  "Ingrid",
  "Kenji",
  "Leila",
  "Noah",
  "Olivia",
  "Rafael",
  "Sofia",
  "Tomas",
  "Yara",
  "Zane",
  "Chloe",
  "Elif",
  "Farah",
  "Gabriel",
  "Isla",
  "Jonas",
  "Keira",
  "Marco",
  "Nadia",
  "Oskar",
  "Quinn",
  "Rosa",
];
const LAST = [
  "Okafor",
  "Lindqvist",
  "Tanaka",
  "Moreau",
  "Patel",
  "Nguyen",
  "Schmidt",
  "Alvarez",
  "Kowalski",
  "Haddad",
  "Fischer",
  "Rossi",
  "Silva",
  "Brennan",
  "Chen",
  "Duarte",
  "Eriksen",
  "Ferreira",
  "Grant",
  "Ito",
  "Kaur",
  "Larsen",
  "Mensah",
  "Novak",
  "Park",
  "Reyes",
  "Sato",
  "Vargas",
];
const COMPANY_A = [
  "Northwind",
  "Bluepeak",
  "Cobalt",
  "Driftwood",
  "Evergreen",
  "Foxglove",
  "Granite",
  "Harbor",
  "Ironclad",
  "Juniper",
  "Keystone",
  "Lumen",
  "Meridian",
  "Nimbus",
  "Orchard",
  "Pinnacle",
  "Quarry",
  "Redwood",
  "Summit",
  "Tidewater",
  "Umbra",
  "Vantage",
  "Westbrook",
  "Yellowtail",
];
const COMPANY_B = [
  "Labs",
  "Systems",
  "Health",
  "Logistics",
  "Capital",
  "Foods",
  "Robotics",
  "Media",
  "Energy",
  "Analytics",
  "Retail",
  "Bio",
  "Networks",
  "Studios",
  "Freight",
  "Holdings",
  "Mobility",
];
const ADJ = [
  "Spring",
  "Summer",
  "Autumn",
  "Winter",
  "Evergreen",
  "Launch",
  "Flagship",
  "Always-on",
  "Regional",
  "Partner",
  "Holiday",
  "Q3",
  "Q4",
  "Back-to-school",
  "Retargeting",
  "Brand",
];
const NOUN = [
  "Push",
  "Promo",
  "Webinar",
  "Nurture",
  "Sprint",
  "Showcase",
  "Roadshow",
  "Drip",
  "Blitz",
  "Series",
  "Bundle",
  "Refresh",
  "Spotlight",
  "Summit",
];
const PRODUCT = [
  "Atlas",
  "Beacon",
  "Canvas",
  "Delta",
  "Echo",
  "Forge",
  "Glide",
  "Helix",
  "Ion",
  "Jet",
  "Kite",
  "Loom",
  "Mosaic",
  "Nova",
  "Orbit",
  "Pulse",
  "Relay",
  "Sonar",
  "Tempo",
  "Vertex",
];
const PRODUCT_KIND = ["Pro", "Lite", "Max", "Mini", "Plus", "One", "X", "Go", "Studio", "Cloud"];
const SERVICE = [
  "api-gateway",
  "auth",
  "billing",
  "catalog",
  "checkout",
  "edge-cache",
  "events",
  "graph",
  "ingest",
  "inventory",
  "ledger",
  "mailer",
  "media",
  "notifications",
  "orders",
  "payments",
  "profiles",
  "queue",
  "ranker",
  "reports",
  "search",
  "sessions",
  "tokens",
  "webhooks",
];
const FEATURE = [
  "Saved views",
  "Bulk edit",
  "Workflows",
  "Comments",
  "SSO",
  "Audit log",
  "Exports",
  "Scheduled reports",
  "Mobile sync",
  "AI summaries",
  "Templates",
  "Integrations",
  "Alerts",
  "Dashboards",
  "Approvals",
  "Custom fields",
  "Webhooks",
  "Offline mode",
  "Guest access",
];
const VENDOR = [
  "Acme Cloud",
  "Brightline Print",
  "Copperleaf Legal",
  "Datastream",
  "Eastgate Freight",
  "Fieldnote Research",
  "Globex Hosting",
  "Helios Power",
  "Inkwell Agency",
  "Jetstream Travel",
  "Kinetic Staffing",
  "Lattice Security",
  "Monarch Facilities",
  "Nexus Telecom",
  "Oakridge Office",
];
const ROLE = [
  "Software Engineer",
  "Account Executive",
  "Data Analyst",
  "Product Designer",
  "Support Specialist",
  "Site Reliability Engineer",
  "Recruiter",
  "Product Manager",
  "Financial Analyst",
  "Marketing Manager",
  "Solutions Architect",
  "Customer Success Manager",
  "Security Engineer",
  "Operations Lead",
];
const SKU_CAT = ["APP", "FTW", "ACC", "HOM", "BTY", "OUT", "ELC", "TOY"];

export function personName(r: Rng): string {
  return `${r.pick(FIRST)} ${r.pick(LAST)}`;
}

/** A realistic name for row `i` of an entity table, unique per (pool, i). */
export function entityName(pool: NamePool, r: Rng, i: number): string {
  switch (pool) {
    case "company":
      return `${r.pick(COMPANY_A)} ${r.pick(COMPANY_B)}`;
    case "person":
      return personName(r);
    case "campaign":
      return `${r.pick(ADJ)} ${r.pick(NOUN)} ${2025 + (i % 2)}`;
    case "product":
      return `${r.pick(PRODUCT)} ${r.pick(PRODUCT_KIND)}`;
    case "service":
      return `${r.pick(SERVICE)}${i >= SERVICE.length ? `-${i}` : ""}`;
    case "invoice":
      return `INV-${padStart(String(48210 + i * 7 + r.int(0, 6)), 6, "0")}`;
    case "shipment":
      return `SHP-${r.int(100, 999)}-${padStart(String(i + 1), 4, "0")}`;
    case "ticket":
      return `#${padStart(String(r.int(20000, 99999)), 5, "0")}`;
    case "feature":
      return r.pick(FEATURE);
    case "sku":
      return `${r.pick(SKU_CAT)}-${padStart(String(r.int(1, 9999)), 4, "0")}`;
    case "vendor":
      return r.pick(VENDOR);
    case "role":
      return r.pick(ROLE);
  }
}
