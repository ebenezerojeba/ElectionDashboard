import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MLMap } from 'maplibre-gl';
import { compact, fmtInt } from '../lib/format';

export interface MapFeatureCollection {
  type: 'FeatureCollection';
  attribution: string | null;
  features: { type: 'Feature'; id: string; properties: { code: string; featureName: string }; geometry: unknown }[];
}

const STEPS = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)', 'var(--seq-6)'];

function cssVar(v: string): string {
  const name = v.replace(/^var\((.+)\)$/, '$1');
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

/** Rounded quantile class breaks so the legend reads cleanly. */
function breaks(values: number[], n = STEPS.length): number[] {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return [];
  const out: number[] = [];
  for (let i = 1; i < n; i++) {
    const q = v[Math.min(v.length - 1, Math.floor((i / n) * v.length))]!;
    const mag = 10 ** Math.max(0, Math.floor(Math.log10(q)) - 1);
    out.push(Math.round(q / mag) * mag);
  }
  return [...new Set(out)];
}

/**
 * LGA choropleth. No third-party basemap tiles are loaded: polygons are drawn on the
 * page surface, so no request leaves the platform. Values come from the aggregates API.
 */
export function ChoroplethMap({
  boundaries,
  values,
  names,
  metricLabel,
  onSelect,
  selected,
}: {
  boundaries: MapFeatureCollection;
  values: Record<string, number>;
  names: Record<string, string>;
  metricLabel: string;
  onSelect?: (code: string) => void;
  selected?: string | null;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const [hover, setHover] = useState<{ code: string; x: number; y: number } | null>(null);
  const [theme, setTheme] = useState(0);
  const br = useMemo(() => breaks(Object.values(values)), [values]);

  const data = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: boundaries.features.map((f) => {
        const v = values[f.properties.code] ?? 0;
        let cls = 0;
        while (cls < br.length && v >= br[cls]!) cls++;
        return { ...f, id: undefined, properties: { ...f.properties, v, cls: v > 0 ? cls : -1 } };
      }),
    }),
    [boundaries, values, br],
  );

  // Re-colour when the colour scheme changes.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setTheme((t) => t + 1);
    mq.addEventListener('change', on);
    const obs = new MutationObserver(on);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', on);
      obs.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': cssVar('var(--surface)') } }] },
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      maxZoom: 12,
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: boundaries.attribution ?? '' }));
    m.on('load', () => {
      m.addSource('areas', { type: 'geojson', data: data as never });
      m.addLayer({ id: 'fill', type: 'fill', source: 'areas', paint: { 'fill-color': '#ccc' } });
      m.addLayer({ id: 'line', type: 'line', source: 'areas', paint: { 'line-color': '#fff', 'line-width': 1.5 } });
      m.addLayer({ id: 'sel', type: 'line', source: 'areas', paint: { 'line-color': '#000', 'line-width': 2.5 }, filter: ['==', ['get', 'code'], ''] });
      const b = new maplibregl.LngLatBounds();
      const walk = (c: unknown): void => {
        if (Array.isArray(c) && typeof c[0] === 'number') b.extend(c as [number, number]);
        else if (Array.isArray(c)) c.forEach(walk);
      };
      boundaries.features.forEach((f) => walk((f.geometry as { coordinates: unknown }).coordinates));
      const fit = () => {
        if (b.isEmpty()) return;
        m.resize();
        m.fitBounds(b, { padding: 16, animate: false });
      };
      fit();
      // Re-fit when the surrounding layout settles or the window changes size.
      const ro = new ResizeObserver(() => fit());
      ro.observe(el.current!);
      m.once('remove', () => ro.disconnect());
      ready.current = true;
      setTheme((t) => t + 1);
    });
    m.on('mousemove', 'fill', (e) => {
      const code = e.features?.[0]?.properties?.code as string | undefined;
      m.getCanvas().style.cursor = code ? 'pointer' : '';
      if (code) setHover({ code, x: e.point.x, y: e.point.y });
    });
    m.on('mouseleave', 'fill', () => {
      m.getCanvas().style.cursor = '';
      setHover(null);
    });
    m.on('click', 'fill', (e) => {
      const code = e.features?.[0]?.properties?.code as string | undefined;
      if (code && onSelect) onSelect(code);
    });
    map.current = m;
    return () => {
      ready.current = false;
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundaries]);

  useEffect(() => {
    const m = map.current;
    // isStyleLoaded() stays false while the GeoJSON source is loading, so track readiness ourselves.
    if (!m || !ready.current || !m.getSource('areas')) return;
    (m.getSource('areas') as GeoJSONSource).setData(data as never);
    const colors = STEPS.map(cssVar);
    const expr: unknown[] = ['match', ['get', 'cls'], -1, cssVar('var(--surface-2)')];
    colors.forEach((c, i) => expr.push(i, c));
    expr.push(colors[0]!);
    m.setPaintProperty('fill', 'fill-color', expr as never);
    m.setPaintProperty('line', 'line-color', cssVar('var(--surface)'));
    m.setPaintProperty('sel', 'line-color', cssVar('var(--ink)'));
    m.setPaintProperty('bg', 'background-color', cssVar('var(--surface)'));
    m.setFilter('sel', ['==', ['get', 'code'], selected ?? '']);
  }, [data, theme, selected]);

  const legend = br.length ? [`< ${compact(br[0]!)}`, ...br.map((b, i) => (i < br.length - 1 ? `${compact(b)}–${compact(br[i + 1]!)}` : `≥ ${compact(b)}`))] : [];

  return (
    <div>
      <div className="relative h-[360px] overflow-hidden rounded-lg border border-line" role="img" aria-label={`Map of ${metricLabel} by LGA. A table with the same values is shown beside the map.`}>
        <div ref={el} style={{ position: "absolute", inset: 0 }} />
        {hover && (
          <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-ink shadow-lg" style={{ left: hover.x, top: hover.y - 10 }}>
            <span className="font-medium">{names[hover.code] ?? hover.code}</span>
            <span className="ml-2 tnum">
              {fmtInt(values[hover.code] ?? 0)} {metricLabel.toLowerCase()}
            </span>
          </div>
        )}
      </div>
      {legend.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-2" aria-label="Map legend">
          <span className="font-medium text-ink">{metricLabel}</span>
          {legend.map((l, i) => (
            <span key={l} className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: STEPS[i] }} />
              {l}
            </span>
          ))}
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-4 rounded-sm border border-line" style={{ background: 'var(--surface-2)' }} />
            No data
          </span>
        </div>
      )}
    </div>
  );
}
