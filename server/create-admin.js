import 'dotenv/config';
import { setServers } from 'node:dns';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

const rl = readline.createInterface({ input, output });
try {
  const name = (await rl.question('CA owner full name: ')).trim();
  const username = (await rl.question('Unique username: ')).trim().toLowerCase();
  const password = await rl.question('Password (12+ characters, letters and numbers): ');
  if (name.length < 2 || !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username) || password.length < 12 || !/[a-z]/i.test(password) || !/\d/.test(password)) throw new Error('Invalid input. Name, username format, and password requirements were not met.');
  const passwordHash = await bcrypt.hash(password, 12);
  if (process.env.MONGODB_URI) {
    const mongoDnsServers = (process.env.MONGODB_DNS_SERVERS || '').split(',').map(server => server.trim()).filter(Boolean);
    if (mongoDnsServers.length) setServers(mongoDnsServers);
    await mongoose.connect(process.env.MONGODB_URI.trim());
    const User = mongoose.model('User', new mongoose.Schema({ name: String, username: { type: String, unique: true }, passwordHash: String, role: String, accountStatus: String, mustChangePassword: Boolean, jobTitle: String, clientId: mongoose.Schema.Types.ObjectId, clientName: String, lastLoginAt: Date }, { timestamps: true }));
    if (await User.exists({ username })) throw new Error('That username is already registered.');
    await User.create({ name, username, passwordHash, role: 'admin', accountStatus: 'active', mustChangePassword: false, jobTitle: 'CA Owner' });
  } else {
    const file = process.env.AUTH_STORE_FILE || path.join(process.cwd(), '.ca-auth-users.json');
    let users = [];
    try { users = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (users.some(user => user.username === username)) throw new Error('That username is already registered.');
    users.push({ _id: crypto.randomUUID(), name, username, passwordHash, role: 'admin', accountStatus: 'active', mustChangePassword: false, jobTitle: 'CA Owner', clientId: null, clientName: '', lastLoginAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(users, null, 2), { mode: 0o600 });
    await fs.chmod(file, 0o600);
  }
  console.log(`Admin account created for @${username}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rl.close();
  if (mongoose.connection.readyState) await mongoose.disconnect();
}
