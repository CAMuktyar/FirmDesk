import 'dotenv/config';
import mongoose from 'mongoose';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { setServers } from 'node:dns';

const uri = process.env.MONGODB_URI?.trim();
if (!uri) {
  console.error('MONGODB_URI is missing. Update it in the project-root .env file.');
  process.exit(1);
}

const dnsServers = (process.env.MONGODB_DNS_SERVERS || '').split(',').map(value => value.trim()).filter(Boolean);
if (dnsServers.length) setServers(dnsServers);

try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 2 });
  const db = mongoose.connection.db;
  if (['admin', 'config', 'local'].includes(db.databaseName)) {
    throw new Error('Refusing to clear a MongoDB system database.');
  }

  const users = db.collection('users');
  const adminDocs = await users.find({ role: 'admin' }).project({ _id: 1, username: 1, passwordHash: 1 }).toArray();
  if (!adminDocs.length) throw new Error('No admin accounts were found; nothing was deleted.');

  const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map(collection => collection.name)
    .filter(name => !name.startsWith('system.'));
  const before = {};
  for (const name of collections) before[name] = await db.collection(name).countDocuments({});
  console.log(`Connected to database: ${db.databaseName}`);
  console.log(`Admin accounts to preserve: ${adminDocs.length}`);
  console.log(`Non-admin and workspace records to remove: ${Object.entries(before).filter(([name]) => name !== 'users').reduce((sum, [, count]) => sum + count, 0) + (before.users || 0) - adminDocs.length}`);

  const rl = readline.createInterface({ input, output });
  const confirmation = await rl.question(`Type CLEAR ${db.databaseName} to permanently remove all non-admin and workspace data: `);
  rl.close();
  if (confirmation !== `CLEAR ${db.databaseName}`) {
    throw new Error('Confirmation did not match. Nothing was deleted.');
  }

  const deleted = {};
  for (const name of collections) {
    if (name === 'users') {
      const result = await users.deleteMany({ role: { $ne: 'admin' } });
      deleted[name] = result.deletedCount;
    } else {
      const result = await db.collection(name).deleteMany({});
      deleted[name] = result.deletedCount;
    }
  }

  const adminsAfter = await users.find({ role: 'admin' }).project({ _id: 1, username: 1, passwordHash: 1 }).toArray();
  const beforeAdminIdentity = adminDocs.map(doc => `${doc._id}:${doc.username}:${doc.passwordHash}`).sort();
  const afterAdminIdentity = adminsAfter.map(doc => `${doc._id}:${doc.username}:${doc.passwordHash}`).sort();
  if (JSON.stringify(beforeAdminIdentity) !== JSON.stringify(afterAdminIdentity)) {
    throw new Error('Admin account verification failed after cleanup. Stop and inspect the database immediately.');
  }

  console.log('Workspace cleanup complete. Admin usernames, password hashes, and IDs were preserved.');
  console.log(JSON.stringify({ database: db.databaseName, adminsPreserved: adminsAfter.length, deleted }, null, 2));
} catch (error) {
  if (error?.codeName === 'AtlasError' || /authentication failed|bad auth/i.test(error?.message || '')) {
    console.error('MongoDB Atlas rejected the credentials in MONGODB_URI. No cleanup was completed; update the project-root .env with the current Atlas database credentials, then retry.');
  } else {
    console.error(error?.message || 'Workspace cleanup failed.');
  }
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
