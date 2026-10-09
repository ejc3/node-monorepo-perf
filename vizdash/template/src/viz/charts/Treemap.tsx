"use client";

import { Group } from "@visx/group";
import { Treemap as VTreemap, hierarchy as vHierarchy, treemapSquarify } from "@visx/hierarchy";
import { Text } from "@visx/text";
import type { TreeNode, Unit } from "@/data/types";
import { formatMetric, formatPercent } from "../format";
import { CHART_HEIGHT, seriesColor, shade } from "../theme";
import { Responsive } from "./Responsive";

/** Two-level treemap: outer groups colored, inner cells shaded by rank. */
export function Treemap({
  data,
  unit,
  height = CHART_HEIGHT.lg,
}: {
  data: TreeNode;
  unit: Unit;
  height?: number;
}) {
  const root = vHierarchy<TreeNode>(data)
    .sum((d) => d.value ?? 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const total = root.value ?? 1;
  const groupIndex = new Map((data.children ?? []).map((c, i) => [c.name, i]));
  return (
    <Responsive height={height}>
      {(width) => (
        <svg width={width} height={height}>
          <VTreemap<TreeNode>
            root={root}
            size={[width, height]}
            tile={treemapSquarify}
            round
            paddingInner={2}
            paddingTop={18}
            paddingOuter={1}
          >
            {(tree) => (
              <Group>
                {tree.descendants().map((node, i) => {
                  const w = node.x1 - node.x0;
                  const h = node.y1 - node.y0;
                  if (node.depth === 0) return null;
                  const group = node.depth === 1 ? node : node.parent!;
                  const base = seriesColor(groupIndex.get(group.data.name) ?? 0);
                  if (node.depth === 1)
                    return (
                      <Group key={`g-${i}`} top={node.y0} left={node.x0}>
                        <rect width={w} height={h} fill={shade(base, 0.38)} rx={3} />
                        {w > 60 ? (
                          <Text
                            x={6}
                            y={12}
                            fontSize={11}
                            fontWeight={650}
                            fill={shade(base, -0.25)}
                            width={w - 12}
                          >
                            {`${node.data.name} · ${formatPercent((node.value ?? 0) / total)}`}
                          </Text>
                        ) : null}
                      </Group>
                    );
                  const rank = node.parent!.children!.indexOf(node);
                  return (
                    <Group key={`l-${i}`} top={node.y0} left={node.x0}>
                      <rect width={w} height={h} fill={shade(base, rank * 0.045)} rx={2}>
                        <title>{`${group.data.name} › ${node.data.name}: ${formatMetric(node.value ?? 0, unit)}`}</title>
                      </rect>
                      {w > 54 && h > 30 ? (
                        <>
                          <Text x={5} y={14} fontSize={11} fill="white" width={w - 10}>
                            {node.data.name}
                          </Text>
                          <Text x={5} y={27} fontSize={10} fill="white" opacity={0.85}>
                            {formatMetric(node.value ?? 0, unit, { compact: true })}
                          </Text>
                        </>
                      ) : null}
                    </Group>
                  );
                })}
              </Group>
            )}
          </VTreemap>
        </svg>
      )}
    </Responsive>
  );
}
