"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts";

export type EChartsOption = echarts.EChartsOption;

/** Mounts an ECharts instance (SVG renderer) and keeps it sized to its container. */
export function EChart({ option, height }: { option: EChartsOption; height: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!el.current) return;
    const instance = echarts.init(el.current, undefined, { renderer: "svg" });
    chart.current = instance;
    const ro = new ResizeObserver(() => instance.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);
  return <div ref={el} style={{ height, width: "100%" }} />;
}
