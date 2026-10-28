import { useEffect } from 'react';
import { useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fieldCls } from './ui';

/** State/LGA picker limited to the user's scope (restricted users see only their own areas). */
export function ScopePicker({ value, onChange, id = 'scope' }: { value: string; onChange: (code: string) => void; id?: string }) {
  const { me } = useAuth();
  const stateWide = me?.user.scope.level === 'state';
  const lgas = useApi<{ children: { _id: string; name: string }[] }>(stateWide ? '/api/geo/node/24' : null);
  const roots = useApi<{ items: { _id: string; name: string }[] }>(stateWide ? null : '/api/geo/roots');
  const options = stateWide ? [{ _id: '24', name: 'Lagos State (all LGAs)' }, ...(lgas.data?.children ?? [])] : (roots.data?.items ?? []);
  useEffect(() => {
    if (!value && options[0]) onChange(options[0]._id);
  }, [options, value, onChange]);
  return (
    <>
      <label htmlFor={id} className="sr-only">
        Area
      </label>
      <select id={id} className={fieldCls('w-64')} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o._id} value={o._id}>
            {o.name}
          </option>
        ))}
      </select>
    </>
  );
}
