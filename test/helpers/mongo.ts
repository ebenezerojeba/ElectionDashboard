import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type Db } from 'mongodb';
import { collections, ensureIndexes, type Collections } from '../../server/db.js';

export interface TestDb {
  server: MongoMemoryServer;
  client: MongoClient;
  db: Db;
  c: Collections;
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const server = await MongoMemoryServer.create({ instance: { args: ['--wiredTigerCacheSizeGB', '0.25'] } });
  const client = await MongoClient.connect(server.getUri());
  const db = client.db('test');
  const c = collections(db);
  await ensureIndexes(c);
  return {
    server,
    client,
    db,
    c,
    reset: async () => {
      for (const coll of await db.collections()) await coll.deleteMany({});
    },
    stop: async () => {
      await client.close();
      await server.stop();
    },
  };
}
