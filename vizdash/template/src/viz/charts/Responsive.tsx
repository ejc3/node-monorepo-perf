"use client";

import { ParentSize } from "@visx/responsive";

/** Renders `children(width)` once the container has a width; a fixed height box until then. */
export function Responsive({
  height,
  children,
}: {
  height: number;
  children: (width: number) => React.ReactNode;
}) {
  return (
    <div style={{ height, width: "100%" }}>
      <ParentSize debounceTime={40}>
        {({ width }) => (width > 0 ? children(width) : null)}
      </ParentSize>
    </div>
  );
}
