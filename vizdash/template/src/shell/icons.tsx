import {
  Activity,
  Briefcase,
  Headphones,
  LayoutDashboard,
  Megaphone,
  Server,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

/** Icons the catalog can name for an area. */
export const AREA_ICONS: Record<string, LucideIcon> = {
  briefcase: Briefcase,
  megaphone: Megaphone,
  wallet: Wallet,
  truck: Truck,
  activity: Activity,
  server: Server,
  headphones: Headphones,
  users: Users,
  cart: ShoppingCart,
  dashboard: LayoutDashboard,
};

export function AreaIcon({ name, size = 16 }: { name: string; size?: number }) {
  const Icon = AREA_ICONS[name] ?? LayoutDashboard;
  return <Icon size={size} />;
}
