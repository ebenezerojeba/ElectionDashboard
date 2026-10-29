import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MLMap, type Marker } from 'maplibre-gl';
import { compact, fmtInt } from '../lib/format';

export interface MapFeatureCollection {
  type: 'FeatureCollection';
  attribution: string | null;
  features: { type: 'Feature'; id: string; properties: { code: string; featureName: string }; geometry: unknown }[];
}

/** One-hue green ramp (light → dark) for magnitude. */
const STEPS = ['var(--map-1)', 'var(--map-2)', 'var(--map-3)', 'var(--map-4)', 'var(--map-5)', 'var(--map-6)'];

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

/** Label anchor: centre of the bounding box of the polygon's largest ring. */
function labelPoint(geometry: unknown): { at: [number, number]; size: number } | null {
  const g = geometry as { type: string; coordinates: number[][][] | number[][][][] };
  const polys = g.type === 'Polygon' ? [g.coordinates as number[][][]] : (g.coordinates as number[][][][]);
  let best: number[][] | null = null;
  let bestSize = -1;
  for (const p of polys) {
    const ring = p[0]!;
    const xs = ring.map((c) => c[0]!);
    const ys = ring.map((c) => c[1]!);
    const size = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    if (size > bestSize) {
      bestSize = size;
      best = ring;
    }
  }
  if (!best) return null;
  const xs = best.map((c) => c[0]!);
  const ys = best.map((c) => c[1]!);
  return { at: [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2], size: bestSize };
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s/-])\S/g, (c) => c.toUpperCase());

/**
 * LGA choropleth drawn as land on lagoon-blue water. No third-party tiles are loaded, so no
 * request leaves the platform. Values come from the aggregates API; a table beside it shows the same numbers.
 */
export function ChoroplethMap({
  boundaries,
  values,
  names,
  metricLabel,
  onSelect,
  selected,
  height = 380,
  unit = '',
  zeroIsData = false,
  categories,
  categoryLegend,
}: {
  boundaries: MapFeatureCollection;
  values: Record<string, number>;
  names: Record<string, string>;
  metricLabel: string;
  onSelect?: (code: string) => void;
  selected?: string | null;
  height?: number;
  unit?: string;
  /** Treat 0 as a real value (lightest class) rather than "no data". */
  zeroIsData?: boolean;
  /** Categorical mode: area code → CSS colour (e.g. senatorial district). Overrides the magnitude ramp. */
  categories?: Record<string, string>;
  categoryLegend?: { label: string; color: string }[];
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const hoverId = useRef<number | null>(null);
  const markers = useRef<{ mk: Marker; size: number }[]>([]);
  const [hover, setHover] = useState<{ code: string; x: number; y: number } | null>(null);
  const [theme, setTheme] = useState(0);
  const br = useMemo(() => breaks(Object.values(values)), [values]);

  const data = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: boundaries.features.map((f, i) => {
        const v = values[f.properties.code] ?? 0;
        let cls = 0;
        while (cls < br.length && v >= br[cls]!) cls++;
        const has = zeroIsData ? f.properties.code in values : v > 0;
        return { ...f, id: i + 1, properties: { ...f.properties, v, cls: has ? cls : -1 } };
      }),
    }),
    [boundaries, values, br, zeroIsData],
  );

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
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': cssVar('var(--water)') } }] },
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      maxZoom: 12,
      minZoom: 7,
    });
    m.touchZoomRotate.disableRotation();
    m.scrollZoom.disable(); // page scrolling should not hijack the map; use the buttons or pinch
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: boundaries.attribution ?? '' }));
    m.on('load', () => {
      m.addSource('areas', { type: 'geojson', data: data as never });
      // Soft shadow under the land: the same shapes offset and darkened.
      m.addLayer({ id: 'shadow', type: 'fill', source: 'areas', paint: { 'fill-color': cssVar('var(--shadow-land)'), 'fill-translate': [2, 3], 'fill-opacity': 1 } });
      m.addLayer({ id: 'fill', type: 'fill', source: 'areas', paint: { 'fill-color': '#ccc' } });
      m.addLayer({ id: 'line', type: 'line', source: 'areas', paint: { 'line-color': '#fff', 'line-width': 1.2 } });
      m.addLayer({
        id: 'hover',
        type: 'line',
        source: 'areas',
        paint: { 'line-color': '#000', 'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.5, 0] },
      });
      m.addLayer({ id: 'sel', type: 'line', source: 'areas', paint: { 'line-color': '#000', 'line-width': 3 }, filter: ['==', ['get', 'code'], ''] });

      // LGA names as HTML labels (no font server needed).
      markers.current = boundaries.features
        .map((f) => {
          const p = labelPoint(f.geometry);
          if (!p) return null;
          const div = document.createElement('div');
          div.className = 'map-label';
          div.textContent = titleCase(names[f.properties.code] ?? f.properties.featureName);
          return { mk: new maplibregl.Marker({ element: div, anchor: 'center' }).setLngLat(p.at).addTo(m), size: p.size };
        })
        .filter((x): x is { mk: Marker; size: number } => !!x)
        .sort((a, b) => b.size - a.size);

      const b = new maplibregl.LngLatBounds();
      const walk = (c: unknown): void => {
        if (Array.isArray(c) && typeof c[0] === 'number') b.extend(c as [number, number]);
        else if (Array.isArray(c)) c.forEach(walk);
      };
      boundaries.features.forEach((f) => walk((f.geometry as { coordinates: unknown }).coordinates));
      const fit = () => {
        if (b.isEmpty()) return;
        m.resize();
        m.fitBounds(b, { padding: { top: 24, bottom: 24, left: 20, right: 48 }, animate: false });
        fitZoom = m.getZoom();
        placeLabels();
      };
      // Large LGAs are labelled at the overview zoom; the dense centre gets names as you zoom in.
      let fitZoom = m.getZoom();
      const placeLabels = () => {
        const wide = m.getContainer().clientWidth > 520;
        const extra = Math.max(0, m.getZoom() - fitZoom);
        const count = !wide ? 0 : extra >= 1.2 ? markers.current.length : extra >= 0.6 ? 14 : 8;
        markers.current.forEach(({ mk }, i) => (mk.getElement().style.display = i < count ? '' : 'none'));
      };
      m.on('zoomend', placeLabels);
      fit();
      const ro = new ResizeObserver(() => fit());
      ro.observe(el.current!);
      m.once('remove', () => ro.disconnect());
      ready.current = true;
      setTheme((t) => t + 1);
    });
    m.on('mousemove', 'fill', (e) => {
      const f = e.features?.[0];
      const code = f?.properties?.code as string | undefined;
      m.getCanvas().style.cursor = code ? 'pointer' : '';
      if (hoverId.current !== null) m.setFeatureState({ source: 'areas', id: hoverId.current }, { hover: false });
      if (f?.id !== undefined) {
        hoverId.current = Number(f.id);
        m.setFeatureState({ source: 'areas', id: hoverId.current }, { hover: true });
      }
      if (code) setHover({ code, x: e.point.x, y: e.point.y });
    });
    m.on('mouseleave', 'fill', () => {
      m.getCanvas().style.cursor = '';
      if (hoverId.current !== null) m.setFeatureState({ source: 'areas', id: hoverId.current }, { hover: false });
      hoverId.current = null;
      setHover(null);
    });
    m.on('click', 'fill', (e) => {
      const code = e.features?.[0]?.properties?.code as string | undefined;
      if (code && onSelect) onSelect(code);
    });
    map.current = m;
    return () => {
      ready.current = false;
      markers.current.forEach(({ mk }) => mk.remove());
      markers.current = [];
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
    let expr: unknown[];
    if (categories && Object.keys(categories).length) {
      expr = ['match', ['get', 'code']];
      for (const [code, col] of Object.entries(categories)) expr.push(code, cssVar(col));
      expr.push(cssVar('var(--surface-2)'));
    } else {
      expr = ['match', ['get', 'cls'], -1, cssVar('var(--surface-2)')];
      colors.forEach((c, i) => expr.push(i, c));
      expr.push(colors[0]!);
    }
    m.setPaintProperty('fill', 'fill-color', expr as never);
    m.setPaintProperty('line', 'line-color', cssVar('var(--land-line)'));
    m.setPaintProperty('shadow', 'fill-color', cssVar('var(--shadow-land)'));
    m.setPaintProperty('hover', 'line-color', cssVar('var(--ink)'));
    m.setPaintProperty('sel', 'line-color', cssVar('var(--ink)'));
    m.setPaintProperty('bg', 'background-color', cssVar('var(--water)'));
    m.setFilter('sel', ['==', ['get', 'code'], selected ?? '']);
  }, [data, theme, selected, categories]);

  const legend = br.length ? [`under ${compact(br[0]!)}${unit}`, ...br.map((b, i) => (i < br.length - 1 ? `${compact(b)}–${compact(br[i + 1]!)}${unit}` : `${compact(b)}${unit}+`))] : [];

  return (
    <div>
      <div className="relative overflow-hidden rounded-[14px] border border-line" style={{ height }} role="img" aria-label={`Map of ${metricLabel} by LGA. A table with the same values is shown beside the map.`}>
        <div ref={el} style={{ position: 'absolute', inset: 0 }} />
        {hover && (
          <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink shadow-lg" style={{ left: hover.x, top: hover.y - 12 }}>
            <p className="font-semibold">{titleCase(names[hover.code] ?? hover.code)}</p>
            <p className="tnum text-ink-2">
              {fmtInt(values[hover.code] ?? 0)}
              {unit} {metricLabel.toLowerCase()}
            </p>
          </div>
        )}
      </div>
      {categoryLegend ? (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-ink-2" aria-label="Map legend">
          {categoryLegend.map((c) => (
            <span key={c.label} className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded-sm" style={{ background: c.color }} aria-hidden="true" />
              {c.label}
            </span>
          ))}
        </div>
      ) : legend.length > 0 && (
        <div className="mt-3" aria-label="Map legend">
          <p className="mb-1.5 text-xs font-medium text-ink-2">{metricLabel}</p>
          <div className="flex overflow-hidden rounded-md">
            {legend.map((_, i) => (
              <span key={i} className="h-2.5 flex-1" style={{ background: STEPS[i] }} />
            ))}
          </div>
          <div className="mt-1 flex text-[11px] text-muted">
            {legend.map((l) => (
              <span key={l} className="tnum flex-1 truncate">
                {l}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
