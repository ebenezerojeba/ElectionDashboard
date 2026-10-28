import type { ReactNode } from 'react';
import { cx } from './ui';

export interface Column<T> {
  key: string;
  label: string;
  numeric?: boolean;
  sortable?: boolean;
  render?: (row: T) => ReactNode;
  className?: string;
}

export function DataTable<T extends Record<string, unknown>>({
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  onRowClick,
  caption,
  empty = 'No rows to show.',
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (r: T) => string;
  sort?: { key: string; dir: 'asc' | 'desc' };
  onSort?: (key: string) => void;
  onRowClick?: (r: T) => void;
  caption?: string;
  empty?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-line">
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cx('whitespace-nowrap px-3 py-2 text-xs font-medium text-muted', c.numeric ? 'text-right' : 'text-left')}
                >
                  {c.sortable && onSort ? (
                    <button className={cx('inline-flex items-center gap-1 hover:text-ink', active && 'text-ink')} onClick={() => onSort(c.key)}>
                      {c.label}
                      <span aria-hidden="true">{active ? (sort!.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-ink-2">
                {empty}
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onRowClick(r)) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              className={cx('border-b border-line last:border-0', onRowClick && 'cursor-pointer hover:bg-surface-2 focus:bg-surface-2')}
            >
              {columns.map((c) => (
                <td key={c.key} className={cx('px-3 py-2.5 align-middle', c.numeric && 'tnum text-right', c.className)}>
                  {c.render ? c.render(r) : String(r[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ page, limit, total, onPage }: { page: number; limit: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-ink-2">
      <span className="tnum">
        {total === 0 ? 'No results' : `${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total.toLocaleString()}`}
      </span>
      <div className="flex items-center gap-1">
        <button className="rounded px-2 py-1 hover:bg-surface-2 disabled:opacity-40" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ← Prev
        </button>
        <span className="tnum px-1">
          {page} / {pages}
        </span>
        <button className="rounded px-2 py-1 hover:bg-surface-2 disabled:opacity-40" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next →
        </button>
      </div>
    </div>
  );
}
