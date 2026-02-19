interface GaugeSegment {
  from: number;
  to: number;
  color: string;
}

interface GaugeChartProps {
  value: number;
  min: number;
  max: number;
  segments: GaugeSegment[];
  label: string;
  unit: string;
  decimals?: number;
}

export function GaugeChart({ value, min, max, segments, label, unit, decimals = 1 }: GaugeChartProps) {
  const cx = 100;
  const cy = 88;
  const r = 68;
  const strokeWidth = 14;

  const clampedValue = Math.min(Math.max(value, min), max);
  const valueToAngle = (v: number) => Math.PI * (1 - (v - min) / (max - min));

  const arcPath = (startAngle: number, endAngle: number) => {
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy - r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy - r * Math.sin(endAngle);
    const largeArc = startAngle - endAngle > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
  };

  const needleAngle = valueToAngle(clampedValue);
  const needleLen = r - 18;
  const needleX = cx + needleLen * Math.cos(needleAngle);
  const needleY = cy - needleLen * Math.sin(needleAngle);

  return (
    <div className="rounded-lg bg-card border border-border p-4 flex flex-col items-center">
      <svg viewBox="0 0 200 115" className="w-full max-w-[180px]">
        {/* Background arc */}
        <path
          d={arcPath(Math.PI, 0)}
          fill="none"
          stroke="hsl(220, 20%, 18%)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        {/* Colored segments */}
        {segments.map((seg, i) => {
          const sAngle = valueToAngle(Math.max(seg.from, min));
          const eAngle = valueToAngle(Math.min(seg.to, max));
          return (
            <path
              key={i}
              d={arcPath(sAngle, eAngle)}
              fill="none"
              stroke={seg.color}
              strokeWidth={strokeWidth}
              strokeLinecap="butt"
              opacity={0.85}
            />
          );
        })}
        {/* Needle */}
        <line
          x1={cx}
          y1={cy}
          x2={needleX}
          y2={needleY}
          stroke="hsl(210, 20%, 90%)"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
        <circle cx={cx} cy={cy} r={4} fill="hsl(210, 20%, 90%)" />
        {/* Value */}
        <text
          x={cx}
          y={cy + 20}
          textAnchor="middle"
          fill="hsl(210, 20%, 90%)"
          fontSize="16"
          fontWeight="600"
          fontFamily="JetBrains Mono, monospace"
        >
          {value.toFixed(decimals)}{unit}
        </text>
      </svg>
      <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wider">{label}</p>
    </div>
  );
}
