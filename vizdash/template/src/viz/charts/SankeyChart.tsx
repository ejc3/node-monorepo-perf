"use client";

import { Group } from "@visx/group";
import { Sankey, sankeyJustify } from "@visx/sankey";
import { Text } from "@visx/text";
import type { FlowResult } from "@/data/types";
import { formatMetric } from "../format";
import { CHART_HEIGHT, seriesColor } from "../theme";
import { Responsive } from "./Responsive";

type N = { name: string; stage: number };
type L = { value: number };

/**
 * Flow between consecutive stages; hovering a link highlights it. The highlight is CSS
 * (.sankey:hover), not React state, so hovering never reruns the layout.
 */
export function SankeyChart({
  data,
  height = CHART_HEIGHT.lg,
}: {
  data: FlowResult;
  height?: number;
}) {
  const root = {
    nodes: data.nodes.map((n) => ({ ...n })),
    links: data.links.map((l) => ({ ...l })),
  };
  return (
    <Responsive height={height}>
      {(width) => (
        <svg width={width} height={height} className="sankey">
          <Sankey<N, L>
            root={root}
            size={[width - 8, height - 8]}
            nodeWidth={12}
            nodePadding={10}
            nodeAlign={sankeyJustify}
            iterations={24}
          >
            {({ graph, createPath }) => (
              <Group top={4} left={4}>
                {graph.links.map((link, i) => {
                  const src = link.source as unknown as N & { index: number };
                  return (
                    <path
                      key={`l${i}`}
                      d={createPath(link) ?? ""}
                      stroke={seriesColor(src.index ?? 0)}
                      strokeWidth={Math.max(1, link.width ?? 1)}
                      className="sankey__link"
                      fill="none"
                    >
                      <title>{formatMetric(link.value, data.unit)}</title>
                    </path>
                  );
                })}
                {graph.nodes.map((node, i) => {
                  const x0 = node.x0 ?? 0;
                  const x1 = node.x1 ?? 0;
                  const y0 = node.y0 ?? 0;
                  const y1 = node.y1 ?? 0;
                  const right = x0 > width / 2;
                  return (
                    <Group key={`n${i}`}>
                      <rect
                        x={x0}
                        y={y0}
                        width={x1 - x0}
                        height={Math.max(1, y1 - y0)}
                        fill={seriesColor(node.index ?? i)}
                        rx={2}
                      />
                      {y1 - y0 > 9 ? (
                        <Text
                          x={right ? x0 - 6 : x1 + 6}
                          y={(y0 + y1) / 2}
                          verticalAnchor="middle"
                          textAnchor={right ? "end" : "start"}
                          fontSize={11}
                          fill="currentColor"
                        >
                          {`${node.name} · ${formatMetric(node.value ?? 0, data.unit, { compact: true })}`}
                        </Text>
                      ) : null}
                    </Group>
                  );
                })}
              </Group>
            )}
          </Sankey>
        </svg>
      )}
    </Responsive>
  );
}
