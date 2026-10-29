/**
 * Compact name-fingerprint index for the online deployment.
 *
 * Each register entry contributes 16 bytes: the last 14 bytes of its name+birth-year fingerprint
 * (HMAC) and a 2-byte polling-unit index. Entries are grouped into buckets by the first 2 bytes
 * (4 hex chars) of the fingerprint. No names, VINs, genders or birth years are stored.
 */
import { Binary, type Collection } from 'mongodb';
import type { VoterRecordDoc } from '../db.js';

export type NameIndexCollection = Collection<{ _id: string; b?: Binary; codes?: string[] }>;

/** Builds the index from a records collection, writing bucket documents via `put`. Runs in 16 passes to bound memory. */
export async function buildNameIndex(
  records: Collection<VoterRecordDoc>,
  put: (docs: { _id: string; b?: Binary; codes?: string[] }[]) => Promise<void>,
  log: (m: string) => void = () => {},
): Promise<{ entries: number; buckets: number; pus: number }> {
  const puCodes = (await records.distinct('pu')).sort() as string[];
  if (puCodes.length > 65535) throw new Error('Too many polling units for a 2-byte index');
  const puIndex = new Map(puCodes.map((p, i) => [p, i]));
  await put([{ _id: 'pus', codes: puCodes }]);
  let entries = 0;
  let buckets = 0;
  for (const first of '0123456789abcdef') {
    const groups = new Map<string, Buffer[]>();
    const cursor = records.find({ nk: { $regex: '^' + first } }, { projection: { nk: 1, pu: 1, _id: 0 } }).batchSize(5000);
    for await (const r of cursor) {
      const e = Buffer.alloc(16);
      Buffer.from(r.nk.slice(4), 'hex').copy(e, 0, 0, 14);
      e.writeUInt16BE(puIndex.get(r.pu)!, 14);
      const key = r.nk.slice(0, 4);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(e);
      entries++;
    }
    const docs = [...groups.entries()].map(([k, list]) => ({ _id: k, b: new Binary(Buffer.concat(list)) }));
    for (let i = 0; i < docs.length; i += 500) await put(docs.slice(i, i + 500));
    buckets += docs.length;
    log(`  pass ${first}: ${docs.length} buckets, ${entries.toLocaleString()} entries so far`);
  }
  return { entries, buckets, pus: puCodes.length };
}
