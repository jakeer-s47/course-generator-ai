import { generateWaveform } from "@/lib/utils";

export function Waveform({
  seed = 42,
  points = 160,
  height = 64,
  stroke = 1.2,
  color = "var(--color-ink-5)",
  highlightColor = "var(--color-accent)",
  highlightUpTo,
  className = "",
  dense = false,
}: {
  seed?: number;
  points?: number;
  height?: number;
  stroke?: number;
  color?: string;
  highlightColor?: string;
  highlightUpTo?: number;
  className?: string;
  dense?: boolean;
}) {
  const data = generateWaveform(seed, points, dense ? 1 : 0.85);
  const w = 100;
  const h = 100;
  const mid = h / 2;
  const step = w / (points - 1);

  const topPath = data
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"} ${(i * step).toFixed(2)} ${(mid - Math.abs(v) * mid * 0.9).toFixed(2)}`,
    )
    .join(" ");
  const botPath = data
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"} ${(i * step).toFixed(2)} ${(mid + Math.abs(v) * mid * 0.9).toFixed(2)}`,
    )
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={className}
      style={{ height, width: "100%", display: "block" }}
      aria-hidden
    >
      {highlightUpTo !== undefined && (
        <defs>
          <clipPath id={`clip-${seed}`}>
            <rect x="0" y="0" width={w * highlightUpTo} height={h} />
          </clipPath>
        </defs>
      )}
      <path
        d={topPath}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
      />
      <path
        d={botPath}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
      />
      {highlightUpTo !== undefined && (
        <g clipPath={`url(#clip-${seed})`}>
          <path
            d={topPath}
            fill="none"
            stroke={highlightColor}
            strokeWidth={stroke * 1.3}
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
          />
          <path
            d={botPath}
            fill="none"
            stroke={highlightColor}
            strokeWidth={stroke * 1.3}
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
          />
        </g>
      )}
    </svg>
  );
}

export function Sparkline({
  seed = 17,
  points = 48,
  height = 18,
  color = "var(--color-ink-5)",
  className = "",
}: {
  seed?: number;
  points?: number;
  height?: number;
  color?: string;
  className?: string;
}) {
  const data = generateWaveform(seed, points, 0.9);
  const w = 100;
  const h = 100;
  const mid = h / 2;
  const step = w / (points - 1);
  const path = data
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"} ${(i * step).toFixed(2)} ${(mid - v * mid * 0.8).toFixed(2)}`,
    )
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={className}
      style={{ height, width: "100%", display: "block" }}
      aria-hidden
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
      />
    </svg>
  );
}
