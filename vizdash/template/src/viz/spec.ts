import type { RangeKey, Scope } from "@/data/types";

/** What every generated dashboard declares about itself (its spec.ts). */
export interface DashboardMeta {
  id: string;
  title: string;
  description: string;
  area: string;
  archetype: string;
  scope: Scope;
  href: string;
  owner: string;
  refresh: string;
  tags: readonly string[];
  defaultRange: RangeKey;
}

export interface DirectoryEntry {
  id: string;
  title: string;
  href: string;
  archetype: string;
  scope: Scope;
}
