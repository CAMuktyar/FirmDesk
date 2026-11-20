import 'dotenv/config';
import { setServers } from 'node:dns';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as webpush from 'web-push';
import { z } from 'zod';

const app = express();
const port = Number(process.env.PORT || 4000);
const isVercel = Boolean(process.env.VERCEL);
const sessionHours = Math.max(1, Number(process.env.SESSION_HOURS || 8));
const sessionSeconds = sessionHours * 60 * 60;
const requestedCookieSameSite = String(process.env.SESSION_COOKIE_SAME_SITE || 'strict').toLowerCase();
const sessionCookieSameSite = ['strict', 'lax', 'none'].includes(requestedCookieSameSite) ? requestedCookieSameSite : 'strict';
const cookieName = 'ca_session';
const authFile = process.env.AUTH_STORE_FILE || path.join(process.cwd(), '.ca-auth-users.json');
const workspaceFile = process.env.WORKSPACE_STORE_FILE || path.join(process.cwd(), '.ca-workspace.json');
const configuredOrigin = process.env.CLIENT_ORIGIN || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173');
const localOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/;
const allowedOrigins = new Set([
  configuredOrigin,
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean),
  process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,
  process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
].filter(Boolean));
const isAllowedOrigin = origin => allowedOrigins.has(origin) || (process.env.NODE_ENV !== 'production' && localOriginPattern.test(origin));
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
if (vapidPublicKey && vapidPrivateKey) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapidPublicKey, vapidPrivateKey);
const jwtSecret = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : crypto.randomBytes(48).toString('base64url'));

if (process.env.NODE_ENV === 'production' && (!jwtSecret || jwtSecret.length < 32)) {
  throw new Error('Set a unique JWT_SECRET of at least 32 characters before starting in production.');
}
if (!jwtSecret) throw new Error('Set JWT_SECRET to a random value of at least 32 characters.');

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(cors({ origin: (origin, callback) => callback(null, !origin || isAllowedOrigin(origin)), credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'X-CSRF-Token'] }));
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !isAllowedOrigin(origin)) return res.status(403).json({ error: 'Request origin is not allowed. Add the deployed website URL to CLIENT_ORIGIN or ALLOWED_ORIGINS.' });
  next();
});

const schema = (name, definition, options = {}) => mongoose.models[name] || mongoose.model(name, new mongoose.Schema(definition, { timestamps: true, ...options }));
const User = schema('User', {
  name: { type: String, required: true, trim: true, maxlength: 100 },
  username: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true, maxlength: 32 },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['admin', 'staff', 'client'], required: true, index: true },
  accountStatus: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  mustChangePassword: { type: Boolean, default: false },
  sessionVersion: { type: Number, default: 0 },
  jobTitle: { type: String, trim: true, maxlength: 80, default: '' },
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientProfile', default: null, index: true },
  clientName: { type: String, trim: true, default: '' },
  lastLoginAt: { type: Date, default: null }
});
const EmployeeProfile = schema('EmployeeProfile', {
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, index: true },
  title: String, active: Boolean, age: { type: Number, min: 16, max: 100 },
  hobbies: { type: String, maxlength: 240 }, nature: { type: String, maxlength: 500 },
  previousWork: { type: String, maxlength: 2500 }, experienceYears: { type: Number, min: 0, max: 70 },
  locked: { type: Boolean, default: false }, lockedAt: Date
});
const ClientProfile = schema('ClientProfile', {
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, sparse: true },
  name: { type: String, required: true, trim: true, index: true }, serviceLines: [String], email: String
});
const Task = schema('Task', {
  title: { type: String, required: true }, description: String,
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientProfile', required: true, index: true },
  assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  service: { type: String, enum: ['ITR', 'GST', 'Accounting', 'Audit', 'Other'], required: true },
  priority: { type: String, enum: ['Normal', 'High', 'Urgent'], default: 'Normal' }, dueDate: { type: Date, required: true, index: true },
  status: { type: String, enum: ['Pending', 'In Progress', 'Waiting for Client', 'Under Review', 'Completed', 'Overdue'], default: 'Pending', index: true },
  progress: { type: Number, min: 0, max: 100, default: 0 }, internalNotes: String, clientComments: String,
  activity: [{ actor: mongoose.Schema.Types.ObjectId, action: String, metadata: mongoose.Schema.Types.Mixed, at: { type: Date, default: Date.now } }]
});
const Conversation = schema('Conversation', {
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientProfile', default: null, index: true },
  task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', default: null }, internal: { type: Boolean, default: false }
});
const Message = schema('Message', {
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', index: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, body: { type: String, required: true, maxlength: 5000 },
  attachment: { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment', default: null }, readBy: [mongoose.Schema.Types.ObjectId]
});
const Notification = schema('Notification', {
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true }, task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task' },
  kind: String, title: { type: String, maxlength: 120 }, message: { type: String, required: true, maxlength: 300 }, readAt: Date, dedupeKey: { type: String, index: true }
});
const PushSubscription = schema('PushSubscription', { owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, endpoint: { type: String, required: true, unique: true }, expirationTime: Number, keys: { p256dh: String, auth: String } });
const Attachment = schema('Attachment', { owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task' }, conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' }, filename: String, mimeType: String, size: Number, storageKey: String });
const ActivityLog = schema('ActivityLog', { actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, entityType: String, entityId: mongoose.Schema.Types.ObjectId, action: String, metadata: mongoose.Schema.Types.Mixed }, { versionKey: false });

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => {});
}
const mongoReady = () => mongoose.connection.readyState === 1;
const safeMongoError = error => String(error?.message || error).replace(/(mongodb(?:\+srv)?:\/\/)[^\s@]+@/gi, '$1[REDACTED]@');
mongoose.connection.on('error', error => console.error('MongoDB connection error:', safeMongoError(error)));
mongoose.connection.on('disconnected', () => {
  console.error('MongoDB disconnected.');
  if (isVercel) {
    vercelMongoInitialization = undefined;
    vercelMongoInitialized = false;
  }
});
const db = (req, res, next) => mongoReady() ? next() : res.status(503).json({ error: 'Database unavailable. Configure MONGODB_URI to use database-backed tasks and conversations.' });
const normalizeUsername = value => String(value || '').trim().toLowerCase();
const usernameRegex = value => new RegExp(`^${normalizeUsername(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
const userId = user => String(user._id || user.id);
const publicUser = user => ({ id: userId(user), name: user.name, username: user.username, role: user.role, accountStatus: user.accountStatus, mustChangePassword: user.role === 'staff' ? false : Boolean(user.mustChangePassword), jobTitle: user.jobTitle || '', clientId: user.clientId ? String(user.clientId) : null, clientName: user.clientName || '', lastLoginAt: user.lastLoginAt || null });
async function findUserByUsername(username) {
  if (mongoReady()) return (await User.findOne({ username: normalizeUsername(username) }).select('+passwordHash').lean()) || User.findOne({ username: usernameRegex(username) }).select('+passwordHash').lean();
  return (await readJson(authFile, [])).find(user => normalizeUsername(user.username) === normalizeUsername(username)) || null;
}
async function findUserById(id) {
  if (mongoReady()) return User.findById(id).select('+passwordHash').lean();
  return (await readJson(authFile, [])).find(user => userId(user) === String(id)) || null;
}
async function listUsers(filter = {}) {
  if (mongoReady()) return User.find(filter).sort({ createdAt: 1 }).select('+passwordHash').lean();
  return (await readJson(authFile, [])).filter(user => Object.entries(filter).every(([key, value]) => value && typeof value === 'object' && Array.isArray(value.$in) ? value.$in.includes(user[key]) : user[key] === value));
}
async function createUser(record) {
  if (mongoReady()) return (await User.create(record)).toObject();
  const users = await readJson(authFile, []);
  if (users.some(user => user.username === record.username)) return null;
  const created = { ...record, _id: new mongoose.Types.ObjectId().toString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  users.push(created); await atomicWrite(authFile, users); return created;
}
async function updateUser(id, changes) {
  if (mongoReady()) return User.findByIdAndUpdate(id, { $set: changes }, { new: true, runValidators: true }).select('+passwordHash').lean();
  const users = await readJson(authFile, []); const index = users.findIndex(user => userId(user) === String(id));
  if (index < 0) return null;
  if (changes.username && users.some((user, i) => i !== index && user.username === changes.username)) return null;
  users[index] = { ...users[index], ...changes, updatedAt: new Date().toISOString() }; await atomicWrite(authFile, users); return users[index];
}
async function persistUserList(users) { await atomicWrite(authFile, users); }
async function readWorkspace() { const data = await readJson(workspaceFile, {}); return { tasks: [], clients: [], conversations: [], messages: [], notifications: [], pushSubscriptions: [], ...data }; }
async function writeWorkspace(data) { await atomicWrite(workspaceFile, data); }
const pushEnabled = () => Boolean(vapidPublicKey && vapidPrivateKey);
async function sendDeviceAlert(userId, payload) {
  if (!pushEnabled()) return;
  const subscriptions = mongoReady() ? await PushSubscription.find({ owner: userId }).lean() : (await readWorkspace()).pushSubscriptions.filter(x => x.owner === String(userId));
  await Promise.allSettled(subscriptions.map(async subscription => {
    try { await webpush.sendNotification({ endpoint: subscription.endpoint, expirationTime: subscription.expirationTime || null, keys: subscription.keys }, JSON.stringify(payload), { TTL: 86400, urgency: 'high' }); }
    catch (error) { if ([404, 410].includes(error.statusCode)) { if (mongoReady()) await PushSubscription.deleteOne({ _id: subscription._id }); else { const d = await readWorkspace();d.pushSubscriptions = d.pushSubscriptions.filter(x => x.endpoint !== subscription.endpoint);await writeWorkspace(d); } } }
  }));
}
async function createUserNotification(recipient, { title, message, kind = 'Firm alert', task = null, dedupeKey = null, sender = null }) {
  if (mongoReady()) {
    if (dedupeKey && await Notification.findOne({ dedupeKey })) return false;
    await Notification.create({ recipient, sender, task, title, message, kind, dedupeKey });
  } else {
    const data = await readWorkspace();if (dedupeKey && data.notifications.some(x => x.dedupeKey === dedupeKey)) return false;
    data.notifications.push({ _id: crypto.randomUUID(), recipient: String(recipient), sender: sender ? String(sender) : null, task: task ? String(task) : null, title, message, kind, dedupeKey, createdAt: new Date().toISOString(), readAt: null });await writeWorkspace(data);
  }
  sendDeviceAlert(recipient, { title, body: kind === 'Admin alert' ? message : 'Open CA Muktyar Ahmad & Co to view this update.', url: '/?open=notifications' }).catch(error => console.error('Push delivery failed:', error.message));return true;
}
async function sendDueDateReminders() {
  const now = Date.now(), low = new Date(now + 24 * 60 * 60 * 1000 - 2 * 60 * 1000), high = new Date(now + 24 * 60 * 60 * 1000);
  if (mongoReady()) {
    const due = await Task.find({ status: { $nin: ['Completed', 'Overdue'] }, dueDate: { $gt: low, $lte: high } }).populate('client', 'name');
    for (const task of due) await createUserNotification(task.assignee, { title: 'Task due in 1 day', message: task.title + ' for ' + (task.client?.name || 'your client') + ' is due in about 24 hours.', kind: 'Due date reminder', task: task._id, dedupeKey: 'due24:' + task._id });
  } else {
    const data = await readWorkspace();const due = data.tasks.filter(task => task.status !== 'Completed' && task.status !== 'Overdue' && task.dueDate && new Date(task.dueDate).getTime() > low.getTime() && new Date(task.dueDate).getTime() <= high.getTime());
    for (const task of due) await createUserNotification(task.assigneeId, { title: 'Task due in 1 day', message: task.title + ' for ' + (task.clientName || 'your client') + ' is due in about 24 hours.', kind: 'Due date reminder', task: task._id, dedupeKey: 'due24:' + task._id });
  }
}
async function bootstrapAdmin() {
  const admins = await listUsers({ role: 'admin' });
  if (admins.length) return;
  const username = normalizeUsername(process.env.ADMIN_USERNAME || String(process.env.ADMIN_EMAIL || '').split('@')[0]);
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.warn('No admin account exists. Run `npm run create-admin` to create the CA owner account.');
    return;
  }
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
  const passwordHash = await bcrypt.hash(password, 12);
  await createUser({ name: process.env.ADMIN_NAME || 'CA Owner', username, passwordHash, role: 'admin', accountStatus: 'active', mustChangePassword: false, jobTitle: 'CA Owner' });
  console.log(`Bootstrapped CA owner account: ${username}`);
}

// Vercel Functions are short-lived and may run concurrently. Cache one MongoDB
// connection/initialization promise per warm function instance; never fall back
// to local JSON files in production because the function filesystem is ephemeral.
let vercelMongoInitialization;
let vercelMongoInitialized = false;
async function initializeVercelMongo() {
  if (!isVercel) return;
  if (vercelMongoInitialized && mongoReady()) return;
  if (vercelMongoInitialization) return vercelMongoInitialization;
  vercelMongoInitialization = (async () => {
    const uri = process.env.MONGODB_URI?.trim();
    if (!uri) throw new Error('MONGODB_URI is not configured.');
    const mongoDnsServers = (process.env.MONGODB_DNS_SERVERS || '').split(',').map(server => server.trim()).filter(Boolean);
    if (mongoDnsServers.length) setServers(mongoDnsServers);
    if (!mongoReady()) await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5 });
    await migrateLegacyUsers();
    await User.init();
    await bootstrapAdmin();
  })();
  try {
    await vercelMongoInitialization;
    vercelMongoInitialized = true;
  } catch (error) {
    vercelMongoInitialization = undefined;
    throw error;
  }
}

const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production' || sessionCookieSameSite === 'none', sameSite: sessionCookieSameSite, path: '/api', maxAge: sessionSeconds * 1000 });
const clearSessionCookie = res => { const { maxAge, ...options } = cookieOptions();res.clearCookie(cookieName, options); };
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) { const index = part.indexOf('='); if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim()); }
  return '';
}
const revokedSessions = new Map();
function issueSession(res, user) {
  const token = jwt.sign({ sub: userId(user), ver: Number(user.sessionVersion || 0), jti: crypto.randomUUID() }, jwtSecret, { expiresIn: sessionSeconds });
  res.cookie(cookieName, token, cookieOptions());
}
const auth = ({ allowPasswordChange = false } = {}) => async (req, res, next) => {
  try {
    const token = readCookie(req, cookieName);
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    const claims = jwt.verify(token, jwtSecret);
    if (claims.jti && revokedSessions.has(claims.jti)) return res.status(401).json({ error: 'Session has ended.' });
    const user = await findUserById(claims.sub);
    if (!user || Number(claims.ver || 0) !== Number(user.sessionVersion || 0) || user.accountStatus !== 'active') { clearSessionCookie(res); return res.status(401).json({ error: 'Account inactive or session expired.' }); }
    req.user = { ...publicUser(user), passwordHash: user.passwordHash };
    if (user.mustChangePassword && user.role !== 'staff' && !allowPasswordChange) return res.status(403).json({ error: 'Change your temporary password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' });
    next();
  } catch { return res.status(401).json({ error: 'Authentication required.' }); }
};
const allow = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Permission denied.' });
const passwordSchema = z.string().min(12).max(128).regex(/[A-Za-z]/).regex(/[0-9]/);
const usernameSchema = z.string().trim().toLowerCase().min(3).max(32).regex(/^[a-z0-9][a-z0-9._-]*$/);
const loginAttempts = new Map();
const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 15 * 60 * 1000;
function rateKey(req, username) { return `${req.ip}:${normalizeUsername(username)}`; }
function isRateLimited(req, username) {
  const entry = loginAttempts.get(rateKey(req, username));
  if (!entry) return false;
  const now = Date.now(); entry.times = entry.times.filter(time => now - time < RATE_WINDOW_MS);
  if (!entry.times.length) { loginAttempts.delete(rateKey(req, username)); return false; }
  loginAttempts.set(rateKey(req, username), entry);
  return entry.times.length >= RATE_LIMIT;
}
function recordFailedLogin(req, username) {
  const key = rateKey(req, username); const entry = loginAttempts.get(key) || { times: [] };
  entry.times = entry.times.filter(time => Date.now() - time < RATE_WINDOW_MS); entry.times.push(Date.now()); loginAttempts.set(key, entry);
}
function clearLoginFailures(req, username) { loginAttempts.delete(rateKey(req, username)); }
const dummyPasswordHash = bcrypt.hashSync('invalid-password-timing-protection', 10);

if (isVercel) {
  app.use('/api', async (req, res, next) => {
    try {
      await initializeVercelMongo();
      next();
    } catch (error) {
      console.error('Vercel MongoDB initialization failed:', safeMongoError(error));
      res.status(503).json({ error: 'The database is unavailable. Check the Vercel MONGODB_URI and MongoDB Atlas Network Access settings.' });
    }
  });
}

app.get('/api/health', (req, res) => {
  const connected = mongoReady();
  res.status(connected ? 200 : 503).json({ success: connected, database: connected ? 'connected' : process.env.MONGODB_URI ? 'disconnected' : 'not configured' });
});
app.post('/api/auth/login', async (req, res) => {
  const parsed = z.object({ username: usernameSchema, password: z.string().min(1).max(128) }).safeParse(req.body);
  const username = normalizeUsername(req.body?.username);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid username and password.' });
  if (isRateLimited(req, username)) return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  let user = await findUserByUsername(username);
  const passwordOk = await bcrypt.compare(parsed.data.password, user?.passwordHash || dummyPasswordHash);
  if (!user || !passwordOk || !['admin', 'staff'].includes(user.role)) { recordFailedLogin(req, username); return res.status(401).json({ error: 'Invalid username or password.' }); }
  if (user.accountStatus !== 'active') { recordFailedLogin(req, username); return res.status(403).json({ error: 'Your account was deactivated by the admin. Contact the CA owner to regain access.', code: 'ACCOUNT_INACTIVE' }); }
  if (user.role === 'staff' && user.mustChangePassword) user = await updateUser(userId(user), { mustChangePassword: false }) || user;
  clearLoginFailures(req, username);
  const updated = await updateUser(userId(user), { lastLoginAt: new Date() });
  issueSession(res, updated || user);
  return res.json({ user: publicUser(updated || user) });
});
app.post('/api/client-auth/login', async (req, res) => {
  const parsed = z.object({ username: usernameSchema, password: z.string().min(1).max(128) }).safeParse(req.body);
  const username = normalizeUsername(req.body?.username);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid client username and password.' });
  if (isRateLimited(req, username)) return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  const user = await findUserByUsername(username);
  const passwordOk = await bcrypt.compare(parsed.data.password, user?.passwordHash || dummyPasswordHash);
  if (!user || !passwordOk || user.role !== 'client') { recordFailedLogin(req, username); return res.status(401).json({ error: 'Invalid client username or password.' }); }
  if (user.accountStatus !== 'active') { recordFailedLogin(req, username); return res.status(403).json({ error: 'This client account is inactive. Contact the firm.' }); }
  clearLoginFailures(req, username);
  const updated = await updateUser(userId(user), { lastLoginAt: new Date() });
  issueSession(res, updated || user);
  return res.json({ user: publicUser(updated || user) });
});
app.post('/api/auth/logout', async (req, res) => { const token = readCookie(req, cookieName); try { const claims = jwt.verify(token, jwtSecret);const user = await findUserById(claims.sub);if (user) await updateUser(claims.sub, { sessionVersion: Number(user.sessionVersion || 0) + 1 });if (claims.jti) { revokedSessions.set(claims.jti, claims.exp || 0);for (const [id, expiry] of revokedSessions) if (expiry * 1000 < Date.now()) revokedSessions.delete(id); } } catch {} clearSessionCookie(res); res.status(204).end(); });
app.get('/api/auth/me', auth({ allowPasswordChange: true }), (req, res) => res.json({ user: publicUser(req.user) }));
app.post('/api/auth/change-password', auth({ allowPasswordChange: true }), async (req, res) => {
  if (req.user.role === 'staff') return res.status(403).json({ error: 'Only the CA owner can change an employee password. Contact the admin to reset it.' });
  const parsed = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Use a password of at least 12 characters with letters and numbers.' });
  if (!await bcrypt.compare(parsed.data.currentPassword, req.user.passwordHash)) return res.status(401).json({ error: 'Current password is incorrect.' });
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  const updated = await updateUser(req.user.id, { passwordHash, mustChangePassword: false, sessionVersion: Number((await findUserById(req.user.id))?.sessionVersion || 0) + 1 });
  issueSession(res, updated);
  res.json({ user: publicUser(updated) });
});

app.get('/api/admin/users', auth(), allow('admin'), async (req, res) => {
  const users = (await listUsers({})).filter(user => ['admin', 'staff'].includes(user.role));
  res.json(users.map(publicUser));
});
app.post('/api/admin/users', auth(), allow('admin'), async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(100), username: usernameSchema, password: passwordSchema, role: z.literal('staff'), jobTitle: z.string().trim().max(80).optional() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a full name, username, employee password (12+ characters), and job title.' });
  if (await findUserByUsername(parsed.data.username)) return res.status(409).json({ error: 'That username is already in use.' });
  const created = await createUser({ name: parsed.data.name, username: parsed.data.username, passwordHash: await bcrypt.hash(parsed.data.password, 12), role: parsed.data.role, accountStatus: 'active', mustChangePassword: false, jobTitle: parsed.data.jobTitle || '' });
  if (!created) return res.status(409).json({ error: 'That username is already in use.' });
  if (mongoReady() && created.role === 'staff') await EmployeeProfile.create({ userId: created._id, title: created.jobTitle, active: true });
  res.status(201).json({ user: publicUser(created) });
});
app.patch('/api/admin/users/:id', auth(), allow('admin'), async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(100).optional(), username: usernameSchema.optional(), accountStatus: z.enum(['active', 'inactive']).optional(), jobTitle: z.string().trim().max(80).optional() }).strict().safeParse(req.body);
  if (!parsed.success || !Object.keys(parsed.data || {}).length) return res.status(400).json({ error: 'No valid account changes supplied.' });
  const target = await findUserById(req.params.id);
  if (!target || target.role !== 'staff') return res.status(404).json({ error: 'Only employee accounts can be edited here.' });
  if (parsed.data.username) { const other = await findUserByUsername(parsed.data.username); if (other && userId(other) !== userId(target)) return res.status(409).json({ error: 'That username is already in use.' }); }
  const userChanges = { ...parsed.data };if (parsed.data.accountStatus) userChanges.sessionVersion = Number(target.sessionVersion || 0) + 1;
  const updated = await updateUser(req.params.id, userChanges);
  if (mongoReady() && updated.role === 'staff' && (parsed.data.accountStatus || parsed.data.jobTitle)) await EmployeeProfile.updateOne({ userId: updated._id }, { $set: { title: updated.jobTitle, active: updated.accountStatus === 'active' } }, { upsert: true });
  res.json({ user: publicUser(updated) });
});
app.post('/api/admin/users/:id/reset-password', auth(), allow('admin'), async (req, res) => {
  const parsed = z.object({ adminPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter your current admin password and a new employee password (12+ characters, with a letter and a number).' });
  if (!await bcrypt.compare(parsed.data.adminPassword, req.user.passwordHash)) return res.status(401).json({ error: 'The current admin password is incorrect.' });
  const target = await findUserById(req.params.id);
  const selfAdminReset = target?.role === 'admin' && userId(target) === req.user.id;
  if (!target || (target.role !== 'staff' && !selfAdminReset)) return res.status(404).json({ error: 'Only employee accounts or your own admin account can be reset here.' });
  const updated = await updateUser(req.params.id, { passwordHash: await bcrypt.hash(parsed.data.newPassword, 12), mustChangePassword: false, sessionVersion: Number(target.sessionVersion || 0) + 1 });
  if (selfAdminReset) issueSession(res, updated);
  res.json({ ok: true, mustChangePassword: false });
});
app.delete('/api/admin/users/:id', auth(), allow('admin'), async (req, res) => {
  const parsed = z.object({ username: usernameSchema }).strict().safeParse(req.body);
  const target = await findUserById(req.params.id);
  if (!target || target.role !== 'staff') return res.status(404).json({ error: 'Employee account not found.' });
  if (!parsed.success || parsed.data.username !== target.username) return res.status(400).json({ error: 'Enter the employee username exactly to confirm permanent removal.' });

  const employeeId = userId(target);
  await updateUser(employeeId, { accountStatus: 'inactive', sessionVersion: Number(target.sessionVersion || 0) + 1 });

  if (mongoReady()) {
    const [taskIds, employeeProfile] = await Promise.all([
      Task.find({ assignee: employeeId }).distinct('_id'),
      EmployeeProfile.findOne({ userId: employeeId }).select('_id').lean()
    ]);
    const taskConversationIds = taskIds.length ? await Conversation.find({ task: { $in: taskIds } }).distinct('_id') : [];
    const authoredMessages = await Message.find({ sender: employeeId }).select('attachment').lean();
    const authoredAttachmentIds = authoredMessages.map(message => message.attachment).filter(Boolean);
    const messageScope = taskConversationIds.length ? { $or: [{ sender: employeeId }, { conversation: { $in: taskConversationIds } }] } : { sender: employeeId };
    const relatedMessages = await Message.find(messageScope).select('_id attachment').lean();
    const attachmentIds = [...new Set([...authoredAttachmentIds, ...relatedMessages.map(message => message.attachment).filter(Boolean).map(String)])];
    const conversationIds = taskConversationIds;

    await Notification.deleteMany(taskIds.length ? { $or: [{ recipient: employeeId }, { task: { $in: taskIds } }] } : { recipient: employeeId });
    await PushSubscription.deleteMany({ owner: employeeId });
    await Message.deleteMany(messageScope);
    await Message.updateMany({ readBy: employeeId }, { $pull: { readBy: employeeId } });
    const attachmentFilter = [{ owner: employeeId }, ...(taskIds.length ? [{ task: { $in: taskIds } }] : []), ...(taskConversationIds.length ? [{ conversation: { $in: taskConversationIds } }] : []), ...(attachmentIds.length ? [{ _id: { $in: attachmentIds } }] : [])];
    await Attachment.deleteMany({ $or: attachmentFilter });
    if (conversationIds.length) await Conversation.deleteMany({ _id: { $in: conversationIds } });
    await Conversation.updateMany({ participants: employeeId }, { $pull: { participants: employeeId } });
    const orphanInternalConversationIds = await Conversation.find({ internal: true, participants: { $size: 0 } }).distinct('_id');
    if (orphanInternalConversationIds.length) {
      const orphanMessages = await Message.find({ conversation: { $in: orphanInternalConversationIds } }).select('attachment').lean();
      const orphanAttachmentIds = orphanMessages.map(message => message.attachment).filter(Boolean);
      await Message.deleteMany({ conversation: { $in: orphanInternalConversationIds } });
      await Attachment.deleteMany({ $or: [{ conversation: { $in: orphanInternalConversationIds } }, ...(orphanAttachmentIds.length ? [{ _id: { $in: orphanAttachmentIds } }] : [])] });
      await Conversation.deleteMany({ _id: { $in: orphanInternalConversationIds } });
    }
    const activityClauses = [{ actor: employeeId }];
    if (employeeProfile) activityClauses.push({ entityType: 'EmployeeProfile', entityId: employeeProfile._id });
    if (taskIds.length) activityClauses.push({ entityType: 'Task', entityId: { $in: taskIds } });
    await ActivityLog.deleteMany({ $or: activityClauses });
    await Task.deleteMany({ assignee: employeeId });
    await EmployeeProfile.deleteMany({ userId: employeeId });
    await User.deleteOne({ _id: target._id, role: 'staff' });
    return res.json({ ok: true, tasksDeleted: taskIds.length, messagesDeleted: relatedMessages.length });
  }

  const workspace = await readWorkspace();
  const removedTasks = workspace.tasks.filter(task => String(task.assigneeId) === employeeId);
  const taskIds = new Set(removedTasks.map(task => String(task._id)));
  const removedConversations = workspace.conversations.filter(conversation => taskIds.has(String(conversation.task)) || (conversation.internal && (conversation.participants || []).every(id => String(id) === employeeId)));
  const conversationIds = new Set(removedConversations.map(conversation => String(conversation._id)));
  const removedMessages = workspace.messages.filter(message => String(message.sender) === employeeId || conversationIds.has(String(message.conversation)));
  workspace.tasks = workspace.tasks.filter(task => !taskIds.has(String(task._id)));
  workspace.notifications = workspace.notifications.filter(item => String(item.recipient) !== employeeId && !taskIds.has(String(item.task)));
  workspace.pushSubscriptions = workspace.pushSubscriptions.filter(item => String(item.owner) !== employeeId);
  workspace.messages = workspace.messages.filter(message => String(message.sender) !== employeeId && !conversationIds.has(String(message.conversation)));
  workspace.messages.forEach(message => { message.readBy = (message.readBy || []).filter(id => String(id) !== employeeId); });
  workspace.conversations = workspace.conversations.filter(conversation => !conversationIds.has(String(conversation._id)));
  workspace.conversations.forEach(conversation => { conversation.participants = (conversation.participants || []).filter(id => String(id) !== employeeId); });
  await writeWorkspace(workspace);
  const authUsers = await readJson(authFile, []);
  await persistUserList(authUsers.filter(user => userId(user) !== employeeId));
  return res.json({ ok: true, tasksDeleted: removedTasks.length, messagesDeleted: removedMessages.length });
});
app.get('/api/team', auth(), allow('admin', 'staff'), async (req, res) => {
  const users = (await listUsers({ role: { $in: ['admin', 'staff'] } })).filter(user => ['admin', 'staff'].includes(user.role) && user.accountStatus === 'active');
  res.json(users.map(user => ({ id: userId(user), name: user.name, username: user.username, role: user.role, title: user.jobTitle || '', accountStatus: user.accountStatus })));
});
app.post('/api/admin/client-accounts', auth(), allow('admin'), async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(100), username: usernameSchema, temporaryPassword: passwordSchema }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a client name, username, and temporary password (12+ characters).' });
  if (await findUserByUsername(parsed.data.username)) return res.status(409).json({ error: 'That username is already in use.' });
  let clientId = null;
  if (mongoReady()) { let profile = await ClientProfile.findOne({ name: parsed.data.name }); if (!profile) profile = await ClientProfile.create({ name: parsed.data.name }); clientId = profile._id; }
  else { const data = await readWorkspace();let profile = data.clients.find(x => x.name.toLowerCase() === parsed.data.name.toLowerCase());if (!profile) { profile = { _id: crypto.randomUUID(), name: parsed.data.name };data.clients.push(profile);await writeWorkspace(data); }clientId = profile._id; }
  const created = await createUser({ name: parsed.data.name, username: parsed.data.username, passwordHash: await bcrypt.hash(parsed.data.temporaryPassword, 12), role: 'client', accountStatus: 'active', mustChangePassword: true, clientId, clientName: parsed.data.name });
  if (!created) return res.status(409).json({ error: 'That username is already in use.' });
  if (mongoReady() && clientId) await Conversation.create({ participants: [req.user.id, created._id], client: clientId, internal: false });
  else { const data = await readWorkspace();data.conversations.push({ _id: crypto.randomUUID(), participants: [req.user.id, userId(created)], clientId: String(clientId), clientName: parsed.data.name, internal: false, createdAt: new Date().toISOString() });await writeWorkspace(data); }
  res.status(201).json({ user: publicUser(created) });
});
app.get('/api/admin/client-accounts', auth(), allow('admin'), async (req, res) => res.json((await listUsers({ role: 'client' })).map(publicUser)));
app.patch('/api/admin/client-accounts/:id', auth(), allow('admin'), async (req, res) => {
  const parsed = z.object({ accountStatus: z.enum(['active', 'inactive']).optional() }).strict().safeParse(req.body);
  const target = await findUserById(req.params.id);
  if (!target || target.role !== 'client') return res.status(404).json({ error: 'Client account not found.' });
  const updated = await updateUser(req.params.id, parsed.data);
  res.json({ user: publicUser(updated) });
});
app.post('/api/admin/client-accounts/:id/reset-password', auth(), allow('admin'), async (req, res) => {
  const target = await findUserById(req.params.id);
  if (!target || target.role !== 'client') return res.status(404).json({ error: 'Client account not found.' });
  const temporaryPassword = 'Temp'+crypto.randomBytes(18).toString('base64url')+'1';
  const updated = await updateUser(req.params.id, { passwordHash: await bcrypt.hash(temporaryPassword, 12), mustChangePassword: true });
  res.json({ user: publicUser(updated), temporaryPassword });
});

app.get('/api/clients', auth(), allow('admin'), async (req, res) => res.json(mongoReady() ? await ClientProfile.find().sort({ name: 1 }) : (await readWorkspace()).clients));
app.post('/api/clients', auth(), allow('admin'), async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(100) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid client name.' });
  if (mongoReady()) { let client = await ClientProfile.findOne({ name: parsed.data.name }); if (!client) client = await ClientProfile.create({ name: parsed.data.name }); return res.status(201).json(client); }
  const data = await readWorkspace(); let client = data.clients.find(x => x.name.toLowerCase() === parsed.data.name.toLowerCase()); if (!client) { client = { _id: crypto.randomUUID(), name: parsed.data.name }; data.clients.push(client); await writeWorkspace(data); }
  res.status(201).json(client);
});

const employeeProfileInput = z.object({ age: z.number().int().min(16).max(100).optional(), hobbies: z.string().trim().max(240).optional(), nature: z.string().trim().max(500).optional(), previousWork: z.string().trim().max(2500).optional(), experienceYears: z.number().min(0).max(70).optional(), locked: z.boolean().optional() }).strict();
app.get('/api/employee-profiles', auth(), allow('admin', 'staff'), db, async (req, res) => res.json(await EmployeeProfile.find().populate('userId', 'name username').select('-__v')));
app.get('/api/employee-profile/me', auth(), allow('staff'), db, async (req, res) => { const profile = await EmployeeProfile.findOne({ userId: req.user.id }); profile ? res.json(profile) : res.status(404).json({ error: 'Employee profile not provisioned.' }); });
app.patch('/api/employee-profile/me', auth({ allowPasswordChange: false }), allow('staff'), db, async (req, res) => {
  const parsed = employeeProfileInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid profile details.', details: parsed.error.flatten() });
  let profile = await EmployeeProfile.findOne({ userId: req.user.id });
  if (profile?.locked && !(parsed.data.locked === false && Object.keys(parsed.data).length === 1)) return res.status(423).json({ error: 'Profile is locked. Unlock it before changing details.' });
  if (!profile) profile = new EmployeeProfile({ userId: req.user.id });
  Object.assign(profile, parsed.data);
  if (parsed.data.locked === true) profile.lockedAt = new Date();
  if (parsed.data.locked === false) profile.lockedAt = undefined;
  await profile.save();
  await ActivityLog.create({ actor: req.user.id, entityType: 'EmployeeProfile', entityId: profile.id, action: parsed.data.locked === true ? 'profile_locked' : parsed.data.locked === false ? 'profile_unlocked' : 'profile_updated' });
  res.json(profile);
});

const taskInput = z.object({ title: z.string().trim().min(2).max(160), description: z.string().max(5000).optional(), client: z.string(), assignee: z.string(), service: z.enum(['ITR', 'GST', 'Accounting', 'Audit', 'Other']), priority: z.enum(['Normal', 'High', 'Urgent']).default('Normal'), dueDate: z.coerce.date(), status: z.enum(['Pending', 'In Progress', 'Waiting for Client', 'Under Review', 'Completed', 'Overdue']).optional(), progress: z.number().min(0).max(100).optional() }).strict();
app.get('/api/tasks', auth(), async (req, res) => {
  if (mongoReady()) { const filter = req.user.role === 'admin' ? {} : req.user.role === 'staff' ? { assignee: req.user.id } : { client: req.user.clientId }; return res.json(await Task.find(filter).populate('client', 'name').populate('assignee', 'name username').sort({ dueDate: 1 })); }
  const data = await readWorkspace(); const users = await listUsers({});
  const rows = data.tasks.filter(t => req.user.role === 'admin' || req.user.role === 'staff' && t.assigneeId === req.user.id || req.user.role === 'client' && t.clientId === req.user.clientId);
  res.json(rows.map(t => ({ ...t, client: { name: t.clientName }, assignee: { name: users.find(u => userId(u) === t.assigneeId)?.name || '' } })).sort((a,b) => new Date(a.dueDate)-new Date(b.dueDate)));
});
app.get('/api/activity', auth(), async (req, res) => {
  const filter = req.user.role === 'admin' ? {} : req.user.role === 'staff' ? { assignee: req.user.id } : { client: req.user.clientId };
  let records, actorNames;
  if (mongoReady()) {
    const tasks = await Task.find(filter).populate('client', 'name').populate('assignee', 'name').sort({ updatedAt: -1 }).limit(100).lean();
    const actorIds = [...new Set(tasks.flatMap(task => (task.activity || []).map(event => String(event.actor || '')).filter(Boolean)))];
    const actors = actorIds.length ? await User.find({ _id: { $in: actorIds } }).select('name').lean() : [];
    actorNames = new Map(actors.map(actor => [String(actor._id), actor.name]));
    records = tasks.flatMap(task => {
      const events = task.activity?.length ? task.activity : [{ actor: task.assignee?._id, action: 'Task updated', metadata: { status: task.status, progress: task.progress }, at: task.updatedAt || task.createdAt }];
      return events.map(event => ({
        _id: String(task._id) + ':' + String(event._id || event.at || task.updatedAt),
        actorName: actorNames.get(String(event.actor)) || task.assignee?.name || 'Team member', action: event.action || 'Task updated',
        metadata: event.metadata || {}, taskTitle: task.title, clientName: task.client?.name || '',
        service: task.service, assigneeName: task.assignee?.name || '', createdAt: event.at || task.updatedAt || task.createdAt
      }));
    });
  } else {
    const data = await readWorkspace();
    const tasks = data.tasks.filter(task => req.user.role === 'admin' || req.user.role === 'staff' && task.assigneeId === req.user.id || req.user.role === 'client' && task.clientId === req.user.clientId);
    const users = await listUsers({});
    const names = new Map(users.map(user => [userId(user), user.name]));
    records = tasks.flatMap(task => {
      const events = task.activity?.length ? task.activity : [{ actor: task.assigneeId, action: 'Task updated', metadata: { status: task.status, progress: task.progress }, at: task.updatedAt || task.createdAt }];
      return events.map((event, index) => ({
        _id: String(task._id) + ':' + String(event.at || index), actorName: names.get(String(event.actor)) || 'Team member',
        action: event.action || 'Task updated', metadata: event.metadata || {}, taskTitle: task.title,
        clientName: task.clientName || '', service: task.service, assigneeName: names.get(String(task.assigneeId)) || '',
        createdAt: event.at || task.updatedAt || task.createdAt
      }));
    });
  }
  if (mongoReady()) {
    const notificationFilter = req.user.role === 'admin' ? { kind: { $in: ['Admin alert', 'Employee work update'] } } : req.user.role === 'staff' ? { $or: [{ recipient: req.user.id, kind: 'Admin alert' }, { sender: req.user.id, kind: 'Employee work update' }] } : null;
    if (notificationFilter) {
      const alerts = await Notification.find(notificationFilter).populate('sender', 'name').populate('recipient', 'name').sort({ createdAt: -1 }).limit(100).lean();
      records.push(...alerts.map(item => {
        const senderName = item.sender?.name || (item.kind === 'Employee work update' ? 'Employee' : 'Admin');
        const sentWorkUpdate = item.kind === 'Employee work update';
        const summary = sentWorkUpdate ? (req.user.role === 'admin' ? `${senderName} sent a work update: ${item.title}` : 'You sent a work update: ' + item.title) : (req.user.role === 'admin' ? `${senderName} sent an alert to ${item.recipient?.name || 'an employee'}: ${item.title}` : `${senderName} sent you an alert: ${item.title}`);
        return { _id: 'notification:' + String(item._id), kind: item.kind, actorName: senderName, action: item.kind, taskTitle: item.title || 'Employee alert', clientName: sentWorkUpdate ? 'Employee notification' : req.user.role === 'admin' ? 'To ' + (item.recipient?.name || 'employee') : 'Sent to you', service: sentWorkUpdate ? 'Employee update' : 'Notification', createdAt: item.createdAt, summary };
      }));
    }
  } else if (req.user.role === 'admin' || req.user.role === 'staff') {
    const data = await readWorkspace();
    const alerts = data.notifications.filter(item => req.user.role === 'admin' ? ['Admin alert', 'Employee work update'].includes(item.kind) : item.kind === 'Admin alert' && String(item.recipient) === req.user.id || item.kind === 'Employee work update' && String(item.sender) === req.user.id);
    const users = await listUsers({});
    const names = new Map(users.map(user => [userId(user), user.name]));
    records.push(...alerts.map(item => {
      const senderName = names.get(String(item.sender)) || (item.kind === 'Employee work update' ? 'Employee' : 'Admin');
      const sentWorkUpdate = item.kind === 'Employee work update';
      const summary = sentWorkUpdate ? (req.user.role === 'admin' ? `${senderName} sent a work update: ${item.title}` : 'You sent a work update: ' + item.title) : (req.user.role === 'admin' ? `${senderName} sent an alert to ${names.get(String(item.recipient)) || 'an employee'}: ${item.title}` : `${senderName} sent you an alert: ${item.title}`);
      return { _id: 'notification:' + String(item._id), kind: item.kind, action: item.kind, actorName: senderName, taskTitle: item.title || 'Employee alert', clientName: sentWorkUpdate ? 'Employee notification' : req.user.role === 'admin' ? 'To ' + (names.get(String(item.recipient)) || 'employee') : 'Sent to you', service: sentWorkUpdate ? 'Employee update' : 'Notification', createdAt: item.createdAt, summary };
    }));
  }
  records.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(records.slice(0, 100).map(item => {
    if (item.kind === 'Admin alert' || item.kind === 'Employee work update') return item;
    const changes = [];
    if (item.metadata.status) changes.push(item.metadata.status);
    if (item.metadata.progress !== undefined) changes.push(item.metadata.progress + '%');
    const eventText = item.action === 'Task created' ? 'created task' : changes.length ? 'updated task · ' + changes.join(' · ') : 'updated task';
    return { ...item, summary: item.actorName + ' ' + eventText + ': ' + item.taskTitle };
  }));
});
app.post('/api/tasks', auth(), allow('admin'), async (req, res) => {
  const parsed = taskInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid task.', details: parsed.error.flatten() });
  if (mongoReady()) {
    let client = mongoose.isValidObjectId(parsed.data.client) ? await ClientProfile.findById(parsed.data.client) : await ClientProfile.findOne({ name: parsed.data.client });
    if (!client) { try { client = await ClientProfile.create({ name: parsed.data.client }); } catch { return res.status(400).json({ error: 'Select a valid client.' }); } }
    const assignee = mongoose.isValidObjectId(parsed.data.assignee) ? await User.findOne({ _id: parsed.data.assignee, role: 'staff', accountStatus: 'active' }) : await User.findOne({ name: parsed.data.assignee, role: 'staff', accountStatus: 'active' });
    if (!assignee) return res.status(400).json({ error: 'Select an active staff account from the employee directory.' });
    const task = await Task.create({ ...parsed.data, client: client._id, assignee: assignee._id, activity: [{ actor: req.user.id, action: 'Task created', metadata: { status: parsed.data.status || 'Pending', progress: parsed.data.progress || 0 } }] });
    await ActivityLog.create({ actor: req.user.id, entityType: 'Task', entityId: task.id, action: 'created', metadata: { title: task.title, status: task.status, progress: task.progress, service: task.service } });
    await createUserNotification(assignee._id, { task: task._id, kind: 'Task assigned', title: 'New task assigned', message: task.title+' was assigned to you.' });
    await Conversation.updateOne({ client: client._id, internal: false }, { $addToSet: { participants: assignee._id } });
    return res.status(201).json(await task.populate([{ path: 'client', select: 'name' }, { path: 'assignee', select: 'name username' }]));
  }
  const data = await readWorkspace();const users = await listUsers({});const assignee = users.find(u => u.name === parsed.data.assignee && u.role === 'staff' && u.accountStatus === 'active');
  if (!assignee) return res.status(400).json({ error: 'Select an active staff account from the employee directory.' });
  const clientName = parsed.data.client.trim();let client = data.clients.find(c => c.name.toLowerCase() === clientName.toLowerCase());if (!client) { client = { _id: crypto.randomUUID(), name: clientName };data.clients.push(client); }
  const task = { _id: crypto.randomUUID(), clientId: String(client._id), title: parsed.data.title, description: parsed.data.description || '', clientName, assigneeId: userId(assignee), service: parsed.data.service, priority: parsed.data.priority, dueDate: parsed.data.dueDate, status: parsed.data.status || 'Pending', progress: parsed.data.progress || 0, clientComments: '', activity: [{ actor: req.user.id, action: 'Task created', metadata: { status: parsed.data.status || 'Pending', progress: parsed.data.progress || 0 }, at: new Date().toISOString() }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  data.tasks.push(task);const clientConversation = data.conversations.find(c => c.clientId === String(client._id) && !c.internal);if (clientConversation && !clientConversation.participants.includes(task.assigneeId)) clientConversation.participants.push(task.assigneeId);await writeWorkspace(data);await createUserNotification(task.assigneeId, { task: task._id, kind: 'Task assigned', title: 'New task assigned', message: task.title+' was assigned to you.' });
  res.status(201).json({ ...task, client: { name: clientName }, assignee: { name: assignee.name, username: assignee.username } });
});
app.patch('/api/tasks/:id', auth(), async (req, res) => {
  let task, localData;
  if (mongoReady()) task = await Task.findById(req.params.id);
  else { localData = await readWorkspace(); task = localData.tasks.find(t => t._id === req.params.id); }
  if (!task) return res.status(404).json({ error: 'Task not found.' });
  const permitted = req.user.role === 'admin' || req.user.role === 'staff' && (mongoReady() ? String(task.assignee) === req.user.id : task.assigneeId === req.user.id) || req.user.role === 'client' && (mongoReady() ? String(task.client) === req.user.clientId : task.clientId === req.user.clientId);
  if (!permitted) return res.status(403).json({ error: 'Permission denied.' });
  const allowedFields = req.user.role === 'client' ? ['clientComments'] : req.user.role === 'admin' ? ['status', 'progress', 'assignee'] : ['status', 'progress'];
  const updates = z.object({ status: z.enum(['Pending', 'In Progress', 'Waiting for Client', 'Under Review', 'Completed', 'Overdue']).optional(), progress: z.number().min(0).max(100).optional(), clientComments: z.string().max(3000).optional(), assignee: z.string().optional() }).strict().safeParse(req.body);
  if (!updates.success || Object.keys(updates.data || {}).some(key => !allowedFields.includes(key))) return res.status(400).json({ error: 'This role cannot change those task fields.' });
  if (updates.data.status === 'Completed' && updates.data.progress === undefined) updates.data.progress = 100;
  const changes = { ...updates.data };delete changes.assignee;let reassignedUser=null;const oldAssigneeId=mongoReady()?String(task.assignee):task.assigneeId;
  if (updates.data.assignee) { const assignee = mongoReady() ? await User.findOne({ name: updates.data.assignee, role: 'staff', accountStatus: 'active' }) : (await listUsers({})).find(u => u.name === updates.data.assignee && u.role === 'staff' && u.accountStatus === 'active');if (!assignee) return res.status(400).json({ error: 'Select an active staff account.' });reassignedUser=assignee;if (mongoReady()) task.assignee = assignee._id;else task.assigneeId = userId(assignee); }
  Object.assign(task, changes);task.activity ||= [];task.activity.push({ actor: req.user.id, action: req.user.role === 'client' ? 'Client update' : 'Task updated', metadata: { ...updates.data, status: task.status, progress: task.progress }, at: new Date().toISOString() });
  if (mongoReady()) { await task.save();await ActivityLog.create({ actor: req.user.id, entityType: 'Task', entityId: task.id, action: 'updated', metadata: { ...updates.data, title: task.title, status: task.status, progress: task.progress, service: task.service } });if (reassignedUser && userId(reassignedUser)!==oldAssigneeId) { await createUserNotification(userId(reassignedUser), { task: task._id, kind: 'Task assigned', title: 'Task assigned to you', message: task.title+' was assigned to you.' });await Conversation.updateOne({ client: task.client, internal: false }, { $addToSet: { participants: reassignedUser._id } }); }return res.json(await task.populate([{ path: 'client', select: 'name' }, { path: 'assignee', select: 'name username' }])); }
  task.updatedAt = new Date().toISOString();await writeWorkspace(localData);if (reassignedUser && userId(reassignedUser)!==oldAssigneeId) { const c=localData.conversations.find(x=>x.clientId===task.clientId&&!x.internal);if(c&&!c.participants.includes(task.assigneeId))c.participants.push(task.assigneeId);await writeWorkspace(localData);await createUserNotification(task.assigneeId,{task:task._id,kind:'Task assigned',title:'Task assigned to you',message:task.title+' was assigned to you.'}); }const assignee = await findUserById(task.assigneeId);res.json({ ...task, client: { name: task.clientName }, assignee: { name: assignee?.name || '' } });
});
app.delete('/api/tasks/:id', auth(), allow('admin'), async (req, res) => {
  if (mongoReady()) { const deleted = await Task.findByIdAndDelete(req.params.id);return deleted ? res.status(204).end() : res.status(404).json({ error: 'Task not found.' }); }
  const data = await readWorkspace();const before = data.tasks.length;data.tasks = data.tasks.filter(t => t._id !== req.params.id);if (data.tasks.length === before) return res.status(404).json({ error: 'Task not found.' });data.notifications = data.notifications.filter(x => x.task !== req.params.id);await writeWorkspace(data);res.status(204).end();
});
app.get('/api/push/public-key', auth(), allow('admin', 'staff'), (req, res) => vapidPublicKey ? res.json({ publicKey: vapidPublicKey }) : res.status(503).json({ error: 'Device alerts are not configured on the server.' }));
app.post('/api/push/subscribe', auth(), allow('admin', 'staff'), async (req, res) => {
  if (!pushEnabled()) return res.status(503).json({ error: 'Device alerts are not configured on the server.' });
  const parsed = z.object({ endpoint: z.string().url().max(2048), expirationTime: z.number().nullable().optional(), keys: z.object({ p256dh: z.string().min(10), auth: z.string().min(5) }).strict() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid device subscription.' });
  if (mongoReady()) await PushSubscription.findOneAndUpdate({ endpoint: parsed.data.endpoint }, { $set: { owner: req.user.id, ...parsed.data } }, { upsert: true, new: true, runValidators: true });
  else { const data = await readWorkspace();data.pushSubscriptions = (data.pushSubscriptions || []).filter(x => x.endpoint !== parsed.data.endpoint);data.pushSubscriptions.push({ ...parsed.data, owner: req.user.id, _id: crypto.randomUUID() });await writeWorkspace(data); }
  res.status(201).json({ ok: true });
});
app.delete('/api/push/subscribe', auth(), allow('admin', 'staff'), async (req, res) => {
  const parsed = z.object({ endpoint: z.string().url().max(2048) }).strict().safeParse(req.body);if (!parsed.success) return res.status(400).json({ error: 'Invalid subscription endpoint.' });
  if (mongoReady()) await PushSubscription.deleteOne({ owner: req.user.id, endpoint: parsed.data.endpoint });else { const data = await readWorkspace();data.pushSubscriptions = (data.pushSubscriptions || []).filter(x => !(x.owner === req.user.id && x.endpoint === parsed.data.endpoint));await writeWorkspace(data); }
  res.status(204).end();
});
app.post('/api/admin/notifications', auth(), allow('admin'), async (req, res) => {
  const parsed = z.object({ recipientId: z.string().min(1), title: z.string().trim().min(2).max(120), message: z.string().trim().min(2).max(300) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a title and message.' });
  const staffUsers = await listUsers({ role: 'staff', accountStatus: 'active' });const recipients = parsed.data.recipientId === 'all' ? staffUsers : staffUsers.filter(x => userId(x) === parsed.data.recipientId);
  if (!recipients.length) return res.status(404).json({ error: 'No active staff account found.' });
  for (const user of recipients) await createUserNotification(userId(user), { title: parsed.data.title, message: parsed.data.message, kind: 'Admin alert', sender: req.user.id });
  res.status(201).json({ sent: recipients.length });
});
app.get('/api/admin/notifications/sent', auth(), allow('admin'), async (req, res) => {
  if (mongoReady()) {
    const items = await Notification.find({ kind: 'Admin alert' }).populate('recipient', 'name username').populate('sender', 'name username').sort({ createdAt: -1 }).limit(200).lean();
    return res.json(items.map(item => ({ _id: String(item._id), title: item.title, message: item.message, createdAt: item.createdAt, readAt: item.readAt || null, recipientName: item.recipient?.name || 'Former employee', recipientUsername: item.recipient?.username || '', senderName: item.sender?.name || 'Admin' })));
  }
  const data = await readWorkspace();const users = await listUsers({});const items = data.notifications.filter(item => item.kind === 'Admin alert').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 200);
  res.json(items.map(item => { const recipient = users.find(user => userId(user) === String(item.recipient));const sender = users.find(user => userId(user) === String(item.sender));return { ...item, recipientName: recipient?.name || 'Former employee', recipientUsername: recipient?.username || '', senderName: sender?.name || 'Admin' }; }));
});
app.post('/api/staff/work-updates', auth(), allow('staff'), async (req, res) => {
  const parsed = z.object({ taskId: z.string().min(1).max(64).optional(), details: z.string().trim().min(5).max(190) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter at least 5 characters of notification details.' });
  let task = null;
  if (parsed.data.taskId) {
    if (mongoReady()) task = await Task.findOne({ _id: parsed.data.taskId, assignee: req.user.id }).select('title').lean();
    else task = (await readWorkspace()).tasks.find(x => x._id === parsed.data.taskId && x.assigneeId === req.user.id);
    if (!task) return res.status(404).json({ error: 'That task is not assigned to your account.' });
  }
  const admins = await listUsers({ role: 'admin', accountStatus: 'active' });
  if (!admins.length) return res.status(503).json({ error: 'No active admin account is available to receive this update.' });
  const title = task ? 'Work update: ' + String(task.title || 'Assigned task').slice(0, 95) : 'Employee notification';
  const message = req.user.name + ': ' + parsed.data.details;
  for (const admin of admins) await createUserNotification(userId(admin), { task: task?._id || null, title, message, kind: 'Employee work update', sender: req.user.id });
  res.status(201).json({ sent: admins.length });
});
app.get('/api/notifications', auth(), async (req, res) => res.json(mongoReady() ? await Notification.find({ recipient: req.user.id }).sort({ createdAt: -1 }).limit(100) : (await readWorkspace()).notifications.filter(x => x.recipient === req.user.id).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt))));
app.get('/api/notifications/sent', auth(), allow('staff'), async (req, res) => {
  if (mongoReady()) {
    const items = await Notification.find({ sender: req.user.id, kind: 'Employee work update' }).select('title message createdAt kind').sort({ createdAt: -1 }).limit(100).lean();
    return res.json(items.map(item => ({ _id: String(item._id), title: item.title, message: item.message, createdAt: item.createdAt, kind: item.kind })));
  }
  const data = await readWorkspace();
  res.json(data.notifications.filter(item => item.sender === req.user.id && item.kind === 'Employee work update').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100));
});
app.patch('/api/notifications/:id/read', auth(), async (req, res) => {
  if (mongoReady()) { const item = await Notification.findOneAndUpdate({ _id: req.params.id, recipient: req.user.id }, { readAt: new Date() }, { new: true });return item ? res.json(item) : res.status(404).json({ error: 'Notification not found.' }); }
  const data = await readWorkspace();const item = data.notifications.find(x => x._id === req.params.id && x.recipient === req.user.id);if (!item) return res.status(404).json({ error: 'Notification not found.' });item.readAt = new Date().toISOString();await writeWorkspace(data);res.json(item);
});
app.delete('/api/notifications/:id', auth(), async (req, res) => {
  if (mongoReady()) { const item = await Notification.findOneAndDelete({ _id: req.params.id, recipient: req.user.id });return item ? res.json({ ok: true }) : res.status(404).json({ error: 'Notification not found.' }); }
  const data = await readWorkspace();const index = data.notifications.findIndex(item => item._id === req.params.id && item.recipient === req.user.id);if (index < 0) return res.status(404).json({ error: 'Notification not found.' });data.notifications.splice(index, 1);await writeWorkspace(data);res.json({ ok: true });
});
app.delete('/api/admin/notifications/sent/:id', auth(), allow('admin'), async (req, res) => {
  if (mongoReady()) { const item = await Notification.findOneAndDelete({ _id: req.params.id, kind: 'Admin alert' });return item ? res.json({ ok: true }) : res.status(404).json({ error: 'Sent employee alert not found.' }); }
  const data = await readWorkspace();const index = data.notifications.findIndex(item => item._id === req.params.id && item.kind === 'Admin alert');if (index < 0) return res.status(404).json({ error: 'Sent employee alert not found.' });data.notifications.splice(index, 1);await writeWorkspace(data);res.json({ ok: true });
});
app.get('/api/conversations', auth(), async (req, res) => {
  if (mongoReady()) { const filter = req.user.role === 'admin' ? {} : req.user.role === 'client' ? { participants: req.user.id, client: req.user.clientId, internal: false } : { participants: req.user.id };return res.json(await Conversation.find(filter).populate('client', 'name').sort({ updatedAt: -1 })); }
  const data = await readWorkspace();const rows = data.conversations.filter(c => req.user.role === 'admin' || c.participants.includes(req.user.id) && (req.user.role !== 'client' || (!c.internal && c.clientName === req.user.clientName)));res.json(rows.map(c => ({ ...c, client: { name: c.clientName } })));
});
app.get('/api/conversations/:id/messages', auth(), async (req, res) => {
  let conversation, data;
  if (mongoReady()) conversation = await Conversation.findById(req.params.id);
  else { data = await readWorkspace();conversation = data.conversations.find(c => c._id === req.params.id); }
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  const participants = (conversation.participants || []).map(String);const owner = mongoReady() ? String(conversation.client) === req.user.clientId : conversation.clientId === req.user.clientId;
  const allowed = req.user.role === 'admin' || participants.includes(req.user.id) && (req.user.role !== 'client' || (!conversation.internal && owner));if (!allowed) return res.status(403).json({ error: 'Permission denied.' });
  if (mongoReady()) return res.json(await Message.find({ conversation: conversation._id }).sort({ createdAt: 1 }).populate('sender', 'name username'));
  const users = await listUsers({});res.json(data.messages.filter(m => m.conversation === conversation._id).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)).map(m=>({ ...m, sender: { name: users.find(u=>userId(u)===m.sender)?.name || 'Team member' } })));
});
app.post('/api/conversations/:id/messages', auth(), async (req, res) => {
  let conversation, data;
  if (mongoReady()) conversation = await Conversation.findById(req.params.id);
  else { data = await readWorkspace();conversation = data.conversations.find(c => c._id === req.params.id); }
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  const participants = (conversation.participants || []).map(String);const owner = mongoReady() ? String(conversation.client) === req.user.clientId : conversation.clientName === req.user.clientName;
  const allowed = req.user.role === 'admin' || participants.includes(req.user.id) && (req.user.role !== 'client' || (!conversation.internal && owner));if (!allowed) return res.status(403).json({ error: 'Permission denied.' });
  const parsed = z.object({ body: z.string().trim().min(1).max(5000) }).strict().safeParse(req.body);if (!parsed.success) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (mongoReady()) return res.status(201).json(await Message.create({ conversation: conversation._id, sender: req.user.id, body: parsed.data.body }));
  const message = { _id: crypto.randomUUID(), conversation: conversation._id, sender: req.user.id, body: parsed.data.body, createdAt: new Date().toISOString() };data.messages.push(message);await writeWorkspace(data);res.status(201).json({ ...message, sender: { name: req.user.name } });
});

app.use((error, req, res, next) => { console.error(error); if (res.headersSent) return next(error); res.status(500).json({ error: 'Unexpected server error.' }); });

async function migrateLegacyUsers() {
  if (!mongoReady()) return;
  const legacy = await User.collection.find({ username: { $exists: false }, email: { $exists: true } }).toArray();
  for (const row of legacy) {
    const base = normalizeUsername(String(row.email).split('@')[0]).replace(/[^a-z0-9._-]/g, '').slice(0, 24) || 'employee';
    let username = base; let suffix = 1;
    while (await User.exists({ username })) { username = `${base.slice(0, 25)}${suffix++}`; }
    const role = row.role === 'employee' ? 'staff' : row.role;
    await User.collection.updateOne({ _id: row._id }, { $set: { username, role, accountStatus: row.accessStatus === 'active' ? 'active' : 'inactive', mustChangePassword: true, sessionVersion: Number(row.sessionVersion || 0), jobTitle: '' }, $unset: { email: '', accessStatus: '' } });
  }
  // Preserve accounts created by older versions that already have a username but use the old role name.
  await User.collection.updateMany({ role: 'employee' }, { $set: { role: 'staff' } });
  // Admin accounts are protected from employee status controls and always remain active.
  await User.collection.updateMany({ role: 'admin', accountStatus: { $ne: 'active' } }, { $set: { accountStatus: 'active', mustChangePassword: false } });
  const indexes = await User.collection.indexes();
  for (const index of indexes) if (index.key?.email && index.name !== '_id_') await User.collection.dropIndex(index.name);
}
let reminderJobBusy = false;
async function runReminderJob() { if (reminderJobBusy) return;reminderJobBusy = true;try { await sendDueDateReminders(); } catch (error) { console.error('Due-date reminder job failed:', error.message); } finally { reminderJobBusy = false; } }
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function connectMongoWithRetry() {
  const uri = process.env.MONGODB_URI.trim();
  const mongoDnsServers = (process.env.MONGODB_DNS_SERVERS || '').split(',').map(server => server.trim()).filter(Boolean);
  if (mongoDnsServers.length) setServers(mongoDnsServers);
  let attempt = 0;
  while (!mongoReady()) {
    attempt += 1;
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    } catch (error) {
      const retrySeconds = Math.min(60, 5 * (2 ** Math.min(attempt - 1, 4)));
      console.error(`MongoDB startup attempt ${attempt} failed:`, safeMongoError(error));
      console.log(`Will retry the Atlas connection in ${retrySeconds} seconds. Check network access and IP allow-list if it keeps failing.`);
      await wait(retrySeconds * 1000);
    }
  }
}
async function start() {
  if (process.env.MONGODB_URI?.trim()) {
    try {
      await connectMongoWithRetry();
      await migrateLegacyUsers();
      await User.init();
      await bootstrapAdmin();
      console.log('Connected to MongoDB Atlas.');
    } catch (error) {
      console.error('MongoDB startup failed:', safeMongoError(error));
      process.exitCode = 1;
      return;
    }
  } else { await bootstrapAdmin(); console.warn('MongoDB is not configured; the private local JSON workspace store will back tasks, clients, conversations, and notifications. Configure MONGODB_URI for MongoDB persistence.'); }
  if (process.exitCode) return;
  app.listen(port, process.env.HOST || '0.0.0.0', () => { console.log(`CA Muktyar Ahmad & Co API listening on port ${port}`);runReminderJob();setInterval(runReminderJob, 60 * 1000); });
}
if (!isVercel) start();

export { app, User, mongoReady };
