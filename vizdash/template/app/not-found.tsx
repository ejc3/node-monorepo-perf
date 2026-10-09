import Link from "next/link";
import { EmptyState } from "@/viz/layout";

export default function NotFound() {
  return (
    <main className="page">
      <EmptyState
        title="This dashboard does not exist"
        hint="It may have been renamed or retired."
      />
      <p style={{ textAlign: "center" }}>
        <Link href="/">Back to the overview</Link>
      </p>
    </main>
  );
}
