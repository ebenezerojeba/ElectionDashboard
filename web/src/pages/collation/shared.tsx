import { fmtDate, titleCase } from '../../lib/format';

export interface TemplateField { key: string; label: string; type: 'integer' | 'text' | 'select'; required: boolean; min?: number; max?: number; options?: string[]; help?: string }
export interface Template { _id: string; name: string; description: string; fields: TemplateField[] }
export interface Submission {
  _id: string;
  exercise: string;
  templateId: string;
  ward: string;
  lga: string;
  status: 'draft' | 'submitted' | 'returned' | 'approved';
  values: Record<string, string | number | null>;
  attachments: { publicId: string; format: string; bytes: number; originalName: string; uploadedAt: string }[];
  receiptNo?: string;
  submittedAt?: string;
  version: number;
  history: { at: string; by: string; action: string; note?: string }[];
  discrepancies?: { field: string; note: string; at: string; by: string }[];
}
export interface Context { exercise: { id: string; label: string }; templates: Template[]; notice: string }

export function History({ items }: { items: Submission['history'] }) {
  return (
    <ol className="space-y-2 border-l border-line pl-4 text-sm">
      {[...items].reverse().map((h, i) => (
        <li key={i}>
          <p className="text-xs text-muted">
            {fmtDate(h.at)} · {h.by}
          </p>
          <p className="font-medium">{titleCase(h.action)}</p>
          {h.note && <p className="text-ink-2">“{h.note}”</p>}
        </li>
      ))}
    </ol>
  );
}

export function ValuesTable({ t, values, discrepancies }: { t: Template; values: Submission['values']; discrepancies?: Submission['discrepancies'] }) {
  return (
    <dl className="divide-y divide-line rounded-lg border border-line text-sm">
      {t.fields.map((f) => {
        const flagged = discrepancies?.filter((d) => d.field === f.key) ?? [];
        return (
          <div key={f.key} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2">
            <dt className="text-ink-2">
              {f.label}
              {flagged.map((d, i) => (
                <span key={i} className="mt-0.5 block text-xs font-medium text-critical">
                  ▲ Discrepancy: {d.note}
                </span>
              ))}
            </dt>
            <dd className="tnum text-right font-medium">{values[f.key] ?? '—'}</dd>
          </div>
        );
      })}
    </dl>
  );
}
