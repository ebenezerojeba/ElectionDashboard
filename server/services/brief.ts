/**
 * One-page executive brief (PDF) generated from live aggregates.
 * Aggregate figures only; carries the same metadata and limitations as other reports.
 */
import PDFDocument from 'pdfkit';
import type { Collections } from '../db.js';
import type { GeoScope } from '../../shared/roles.js';
import { AGE_BANDS } from '../../shared/geo.js';
import { auditRows, DEFAULT_ASSUMPTIONS, planRows } from './insights.js';
import type { VerificationSummary } from '../../worker/verify.js';

const GREEN = '#14532d';
const BLUE = '#2a78d6';
const ORANGE = '#eb6834';
const GREY = '#b6b4ac';
const INK = '#111111';
const MUTED = '#6b6a66';
const LINE = '#e1e0d9';
const nf = (n: number) => n.toLocaleString('en-NG');
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

export async function renderBrief(c: Collections, code: string, scope: GeoScope, meta: { generatedBy: string; synthetic: boolean; registerMode: boolean }): Promise<Buffer> {
  const unit = await c.agg.findOne({ _id: code });
  const children = await c.agg.find({ parent: code }).sort({ records: -1 }).toArray();
  const v = (await c.settings.findOne({ _id: 'verification' }))?.value as VerificationSummary | undefined;
  const plan = await planRows(c, code, DEFAULT_ASSUMPTIONS);
  const audit = await auditRows(c, code, scope);
  const auditTotal = audit.reduce((a, r) => ({ dupVin: a.dupVin + r.dupVin, possibleDup: a.possibleDup + r.possibleDup, bad: a.bad + r.badBirthYear + r.rejected + r.countMismatch }), { dupVin: 0, possibleDup: 0, bad: 0 });
  if (!unit) throw new Error('No aggregates for this area');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, info: { Title: `Executive Brief — ${unit.name}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width;
    const L = 36;
    const CW = W - 72;

    // Header band
    doc.rect(0, 0, W, 78).fill(GREEN);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text('Executive Brief', L, 20);
    doc.font('Helvetica').fontSize(10).text(`${unit.name}${code === '24' ? ' State' : ''} · voter register intelligence`, L, 44);
    doc.fontSize(8).text(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${meta.generatedBy}`, L, 58);
    const notice = meta.synthetic ? 'SYNTHETIC DEMONSTRATION DATA — NOT OFFICIAL STATISTICS' : 'CONFIDENTIAL — derived from the INEC display register; not official INEC statistics';
    doc.font('Helvetica-Bold').fontSize(7.5).text(notice, W / 2, 24, { width: W / 2 - L, align: 'right' });
    if (v) doc.font('Helvetica').text(`Register printed ${v.referenceYear} · verified ${new Date(v.at).toISOString().slice(0, 10)}`, W / 2, 36, { width: W / 2 - L, align: 'right' });

    // KPI row
    const kpis: [string, string, string][] = [
      ['Validated voters', nf(unit.records), unit.pusComplete === unit.pus ? `matches register totals (${pct(unit.records, unit.expected ?? 0)})` : `${nf(unit.pusComplete)} of ${nf(unit.pus)} PUs fully processed`],
      ['Polling units', nf(unit.pus), `${nf(plan.totals.wards)} wards · avg ${nf(plan.totals.avgPerPu)} voters/PU`],
      ['Youth (18–34)', `${(plan.totals.youthShare * 100).toFixed(1)}%`, `65+: ${(plan.totals.seniorShare * 100).toFixed(1)}% of voters with known age`],
      ['Agents needed', nf(plan.totals.totalAgents), `${nf(plan.totals.pusOverThreshold)} PUs above ${DEFAULT_ASSUMPTIONS.threshold} voters`],
    ];
    let y = 96;
    const kw = (CW - 3 * 10) / 4;
    kpis.forEach(([label, value, sub], i) => {
      const x = L + i * (kw + 10);
      doc.roundedRect(x, y, kw, 68, 6).lineWidth(0.8).strokeColor(LINE).stroke();
      doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(label, x + 10, y + 9, { width: kw - 20 });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(19).text(value, x + 10, y + 22, { width: kw - 20 });
      doc.fillColor(MUTED).font('Helvetica').fontSize(6.8).text(sub, x + 10, y + 48, { width: kw - 20 });
    });
    y += 84;

    // Gender bar
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text('Gender', L, y);
    y += 14;
    const gTotal = unit.female + unit.male + unit.genderUnknown || 1;
    let gx = L;
    for (const [val, col] of [[unit.female, BLUE], [unit.male, ORANGE], [unit.genderUnknown, GREY]] as [number, string][]) {
      const w = (val / gTotal) * CW;
      if (w > 0) doc.rect(gx, y, Math.max(w - 1.5, 0.5), 10).fill(col);
      gx += w;
    }
    y += 15;
    doc.font('Helvetica').fontSize(7.5);
    let lx = L;
    for (const [label, col] of [
      [`Female ${nf(unit.female)} (${pct(unit.female, gTotal)})`, BLUE],
      [`Male ${nf(unit.male)} (${pct(unit.male, gTotal)})`, ORANGE],
      [`Unavailable ${nf(unit.genderUnknown)} (${pct(unit.genderUnknown, gTotal)}) — alphabetical-only copies`, GREY],
    ] as [string, string][]) {
      doc.rect(lx, y + 1, 7, 7).fill(col);
      doc.fillColor(INK).text(label, lx + 10, y, { lineBreak: false });
      lx += 10 + doc.widthOfString(label) + 16;
    }
    const known = unit.female + unit.male;
    if (known) {
      y += 11;
      doc.fillColor(MUTED).fontSize(7.5).text(`Among voters with known gender: Female ${pct(unit.female, known)} · Male ${pct(unit.male, known)}`, L, y, { lineBreak: false });
    }
    y += 20;

    // Left: areas bar chart; right: age profile + ops + audit
    const colL = CW * 0.56;
    const colR = CW - colL - 18;
    const xR = L + colL + 18;
    const top = y;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(`Validated voters by ${children[0]?.level === 'lga' ? 'LGA' : children[0]?.level === 'ward' ? 'ward' : 'polling unit'}`, L, y);
    y += 15;
    const list = children.slice(0, 20);
    const max = Math.max(1, ...list.map((c2) => c2.records));
    const rowH = Math.min(16, 330 / Math.max(1, list.length));
    const labelW = 98;
    for (const ch of list) {
      doc.fillColor(INK).font('Helvetica').fontSize(7).text(ch.name, L, y + 2, { width: labelW - 4, ellipsis: true, lineBreak: false });
      const bw = ((colL - labelW - 44) * ch.records) / max;
      doc.rect(L + labelW, y + 1.5, Math.max(bw, 0.5), rowH - 5).fill(BLUE);
      doc.fillColor(INK).fontSize(7).text(nf(ch.records), L + labelW + bw + 4, y + 2, { lineBreak: false });
      y += rowH;
    }

    // Age profile
    let yr = top;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text('Age profile', xR, yr);
    yr += 15;
    const bands = AGE_BANDS.filter((b) => b !== 'unknown');
    const bTotal = bands.reduce((a, b) => a + (unit.ageBands[b] ?? 0), 0) || 1;
    const bMax = Math.max(1, ...bands.map((b) => unit.ageBands[b] ?? 0));
    for (const b of bands) {
      const val = unit.ageBands[b] ?? 0;
      doc.fillColor(INK).font('Helvetica').fontSize(7).text(b, xR, yr + 1.5, { width: 32 });
      const bw = ((colR - 80) * val) / bMax;
      doc.rect(xR + 34, yr + 1, Math.max(bw, 0.5), 8).fill(BLUE);
      doc.fillColor(INK).text(pct(val, bTotal), xR + 38 + bw, yr + 1.5, { lineBreak: false });
      yr += 13;
    }
    yr += 10;

    const box = (title: string, lines: [string, string][]) => {
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(title, xR, yr);
      yr += 14;
      for (const [k, val] of lines) {
        doc.font('Helvetica').fontSize(7.8).fillColor(MUTED).text(k, xR, yr, { width: colR - 60 });
        doc.font('Helvetica-Bold').fillColor(INK).text(val, xR + colR - 70, yr, { width: 70, align: 'right' });
        yr += 12;
      }
      yr += 8;
    };
    box('Field operations (planning estimate)', [
      ['Polling-unit agents (1 per PU)', nf(plan.totals.puAgents)],
      [`Extra agents (PUs > ${DEFAULT_ASSUMPTIONS.threshold} voters)`, nf(plan.totals.extraAgents)],
      ['Ward collation agents', nf(plan.totals.collationAgents)],
      ['LGA supervisors', nf(plan.totals.supervisors)],
      ['Total field personnel', nf(plan.totals.totalAgents)],
      ['Largest polling unit (voters)', nf(plan.totals.largestPu)],
    ]);
    box('Register audit (for claims & objections)', [
      ['Records whose VIN appears in another PU', nf(auditTotal.dupVin)],
      ['Name matches for manual review (low confidence)', nf(auditTotal.possibleDup)],
      ['Implausible / invalid entries', nf(auditTotal.bad)],
    ]);
    if (v && code === '24') {
      box('Data assurance', [
        ['Polling units reconciled to register totals', `${nf(v.reconciliation.pusBalanced)} / ${nf(v.coverage.pusCatalogued)}`],
        ['Source files processed', `${nf(v.files.done)} / ${nf(v.files.catalogued)}`],
      ]);
    }

    // Footer
    const fy = doc.page.height - 74;
    doc.moveTo(L, fy).lineTo(W - L, fy).lineWidth(0.6).strokeColor(LINE).stroke();
    doc.fillColor(MUTED).font('Helvetica').fontSize(6.6).text(
      'Definitions: "Validated voters" are distinct (polling unit, VIN) register entries that passed validation; duplicate copies of a register are counted once. ' +
        'Agent numbers are planning estimates (1 per PU, +1 per 500 voters above 750, 1 per ward, 2 per LGA) and can be adjusted in the Field Operations Planner. ' +
        'Audit findings are candidates for review, not confirmed irregularities. Aggregate figures only — no individual voter information is included. ' +
        (meta.synthetic ? 'All figures in this document are synthetic.' : 'Figures are derived from the register files supplied and are not official INEC statistics.'),
      L,
      fy + 6,
      { width: CW, align: 'left' },
    );
    doc.end();
  });
}
