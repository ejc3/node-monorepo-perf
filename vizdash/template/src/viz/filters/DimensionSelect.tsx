"use client";

export function DimensionSelect({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string | null;
  values: readonly string[];
  onChange: (v: string | null) => void;
}) {
  return (
    <label className="select">
      <span>{label}</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">All</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}
