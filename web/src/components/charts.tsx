import { useState, type ReactNode } from 'react';
import { compact, fmtInt, pct } from '../lib/format';

/** Floating tooltip used by all charts. */
function Tip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-ink shadow-lg"
      style={{ left: x, top: y - 8 }}
    >
      {children}
    </div>
  );
}

/**
 * Horizontal bars, single series (magnitude): one hue, value at the tip,
 * <=20px bars with a 4px rounded data-end, hairline baseline.
 */
export function BarList({
  items,
  valueLabel,
  onSelect,
  max: maxOverride,
}: {
  items: { key: string; label: string; value: number; sub?: string }[];
  valueLabel: string;
  onSelect?: (key: string) => void;
  max?: number;
}) {
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const max = maxOverride ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <ul className="space-y-1.5" aria-label={valueLabel}>
        {items.map((it, i) => {
          const w = (it.value / max) * 100;
          const Comp = onSelect ? 'button' : 'div';
          return (
            <li key={it.key}>
              <Comp
                {...(onSelect ? { onClick: () => onSelect(it.key), type: 'button' as const } : {})}
                onMouseMove={(e: React.MouseEvent) => {
                  const host = (e.currentTarget as HTMLElement).closest('.relative')!.getBoundingClientRect();
                  setHover({ i, x: e.clientX - host.left, y: e.clientY - host.top });
                }}
                className="group grid w-full grid-cols-[minmax(90px,34%)_1fr] items-center gap-3 rounded-md py-0.5 text-left hover:bg-surface-2"
              >
                <span className="truncate pl-1 text-[13px] text-ink-2 group-hover:text-ink">{it.label}</span>
                <span className="flex items-center gap-2">
                  <span className="relative h-[18px] flex-1">
                    <span className="absolute inset-y-0 left-0 border-l border-line-strong" aria-hidden="true" />
                    <span className="absolute inset-y-0 left-0 rounded-r-[4px] bg-[var(--accent)]" style={{ width: `${Math.max(w, it.value > 0 ? 0.6 : 0)}%` }} aria-hidden="true" />
                  </span>
                  <span className="tnum w-14 shrink-0 text-right text-xs text-ink">{compact(it.value)}</span>
                </span>
              </Comp>
            </li>
          );
        })}
      </ul>
      {hover && items[hover.i] && (
        <Tip x={hover.x} y={hover.y}>
          <span className="font-medium">{items[hover.i]!.label}</span>
          <span className="ml-2 tnum">
            {fmtInt(items[hover.i]!.value)} {valueLabel.toLowerCase()}
          </span>
          {items[hover.i]!.sub && <span className="block text-muted">{items[hover.i]!.sub}</span>}
        </Tip>
      )}
    </div>
  );
}

/** One stacked bar (parts of a whole) with legend + direct labels; 2px surface gaps between segments. */
export function StackedBar({ parts, label }: { parts: { key: string; label: string; value: number; color: string }[]; label: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);
  return (
    <div>
      <div className="relative" onMouseLeave={() => setHover(null)}>
        <div className="flex h-6 w-full gap-[2px] overflow-hidden rounded-[4px]" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${fmtInt(p.value)} (${pct(p.value, total)})`).join(', ')}`}>
          {total === 0 && <div className="h-full w-full bg-surface-2" />}
          {parts.map((p, i) =>
            p.value > 0 ? (
              <div
                key={p.key}
                style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
                className="h-full min-w-[2px]"
                onMouseMove={(e) => {
                  const host = e.currentTarget.parentElement!.getBoundingClientRect();
                  setHover({ i, x: e.clientX - host.left });
                }}
              />
            ) : null,
          )}
        </div>
        {hover && parts[hover.i] && (
          <Tip x={hover.x} y={0}>
            <span className="font-medium">{parts[hover.i]!.label}</span> <span className="tnum">{fmtInt(parts[hover.i]!.value)}</span> <span className="text-muted">({pct(parts[hover.i]!.value, total)})</span>
          </Tip>
        )}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5 text-ink-2">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} aria-hidden="true" />
            {p.label}
            <span className="tnum font-medium text-ink">{fmtInt(p.value)}</span>
            <span className="tnum text-muted">{pct(p.value, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Vertical columns for an ordered distribution (age bands). */
export function Columns({ items, unit }: { items: { key: string; label: string; value: number }[]; unit: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...items.map((i) => i.value));
  const total = items.reduce((a, b) => a + b.value, 0);
  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <div className="flex h-40 items-end gap-2 border-b border-line-strong" role="img" aria-label={items.map((i) => `${i.label}: ${fmtInt(i.value)}`).join(', ')}>
        {items.map((it, i) => (
          <div key={it.key} className="relative flex h-full flex-1 flex-col items-center justify-end" onMouseEnter={() => setHover(i)}>
            <span className="tnum mb-1 text-[11px] text-ink-2">{compact(it.value)}</span>
            <div className="w-full max-w-6 rounded-t-[4px] bg-[var(--accent)]" style={{ height: `${(it.value / max) * 78}%`, minHeight: it.value ? 2 : 0, opacity: hover === null || hover === i ? 1 : 0.55 }} />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-2">
        {items.map((it) => (
          <span key={it.key} className="flex-1 text-center text-[11px] text-muted">
            {it.label}
          </span>
        ))}
      </div>
      {hover !== null && items[hover] && (
        <p className="mt-2 text-xs text-ink-2" aria-live="polite">
          <span className="font-medium text-ink">{items[hover]!.label}:</span> <span className="tnum">{fmtInt(items[hover]!.value)}</span> {unit} ({pct(items[hover]!.value, total)})
        </p>
      )}
    </div>
  );
}
