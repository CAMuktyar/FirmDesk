import 'dotenv/config';
import { setServers } from 'node:dns';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

const rl = readline.createInterface({ input, output });
const normalize = value => String(value || '').trim().toLowerCase();
const validUsername = value => /^[a-z0-9][a-z0-9._-]{2,31}$/.test(value);
try {
  const username = normalize(await rl.question('Admin username: '));
  const password = await rl.question('New admin password (12+ characters, letters and numbers): ');
  if (!validUsername(username) || password.length < 12 || !/[a-z]/i.test(password) || !/\d/.test(password)) {
    throw new Error('Invalid input. Use a valid username and a password with at least 12 characters, including letters and numbers.');
  }
  const passwordHash = await bcrypt.hash(password, 12);

  if (process.env.MONGODB_URI?.trim()) {
    const dnsServers = (process.env.MONGODB_DNS_SERVERS || '').split(',').map(x => x.trim()).filter(Boolean);
    if (dnsServers.length) setServers(dnsServers);
    await mongoose.connect(process.env.MONGODB_URI.trim());
    const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({
      name: String, username: { type: String, unique: true }, passwordHash: String, role: String,
      accountStatus: String, mustChangePassword: Boolean, sessionVersion: Number, jobTitle: String,
      clientId: mongoose.Schema.Types.ObjectId, clientName: String, lastLoginAt: Date
    }, { timestamps: true }));
    const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const target = await User.findOne({ role: 'admin', username: { $regex: `^${escapedUsername}$`, $options: 'i' } }).lean();
    if (!target) {
      const existing = await User.find({ role: 'admin' }).select('username').lean();
      if (existing.length) throw new Error(`Admin username not found. Existing admin usernames: ${existing.map(x => '@' + x.username).join(', ')}`);
      const name = (await rl.question('CA owner full name: ')).trim() || 'CA Owner';
      await User.create({ name, username, passwordHash, role: 'admin', accountStatus: 'active', mustChangePassword: false, sessionVersion: 0, jobTitle: 'CA Owner' });
      console.log(`Created the CA owner account @${username}.`);
    } else {
      await User.updateOne({ _id: target._id }, { $set: { passwordHash, accountStatus: 'active', mustChangePassword: false, sessionVersion: Number(target.sessionVersion || 0) + 1 } });
      console.log(`Admin password reset for @${target.username}. The account is active.`);
    }
  } else {
    const file = process.env.AUTH_STORE_FILE || path.join(process.cwd(), '.ca-auth-users.json');
    let users = [];
    try { users = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const target = users.find(user => user.role === 'admin' && normalize(user.username) === username);
    if (!target) {
      const existing = users.filter(user => user.role === 'admin');
      if (existing.length) throw new Error(`Admin username not found. Existing admin usernames: ${existing.map(x => '@' + x.username).join(', ')}`);
      const name = (await rl.question('CA owner full name: ')).trim() || 'CA Owner';
      users.push({ _id: crypto.randomUUID(), name, username, passwordHash, role: 'admin', accountStatus: 'active', mustChangePassword: false, sessionVersion: 0, jobTitle: 'CA Owner', clientId: null, clientName: '', lastLoginAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      console.log(`Created the CA owner account @${username}.`);
    } else {
      target.passwordHash = passwordHash;
      target.accountStatus = 'active';
      target.mustChangePassword = false;
      target.sessionVersion = Number(target.sessionVersion || 0) + 1;
      target.updatedAt = new Date().toISOString();
      console.log(`Admin password reset for @${target.username}. The account is active.`);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(users, null, 2), { mode: 0o600 });
    await fs.chmod(file, 0o600);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rl.close();
  if (mongoose.connection.readyState) await mongoose.disconnect();
}
