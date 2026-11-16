# CA Muktyar Ahmad & Co

A responsive CA firm task portal with separate private employee and client sign-in. Employees use a username and password created by the CA owner. Public employee registration and email-based employee authentication are disabled.

## Run locally

Requirements: Node.js 22+ and npm. `npm run dev` starts the API and Vite together; stop both with Ctrl+C:

```sh
npm install
npm run dev
```

When `MONGODB_URI` is set, the API retries Atlas connections with increasing delays until the database is reachable. Vite is available while it retries, but database-backed features work after the API connects. `npm run server` remains available to run only the API.

Open [http://localhost:5173](http://localhost:5173). If the API reports that no administrator exists, create the owner account interactively:

```sh
npm run create-admin
```

The command asks for a full name, unique username, and strong password. It stores only a bcrypt hash and writes the local account file with owner-only permissions. Alternatively configure `ADMIN_NAME`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` in `.env` to bootstrap the first admin at API startup. The password must be at least 12 characters with letters and numbers. Never commit `.env` or account-store files.

If the owner cannot sign in, run `npm run reset-admin` from the project folder. Enter the existing admin username and a new strong password. This resets that admin account's password, restores its active status, and does not reveal or store a plaintext password. The MongoDB-backed command requires Atlas to be reachable from the current network.

The admin signs in, then manages employee accounts in **Employees**: create accounts with a unique username and password, edit name/username/job title, assign Admin or Staff role, reset passwords, and activate/deactivate accounts. Employee credentials remain active until an admin resets them; employees cannot change their own passwords. Employee access is username-only; email is not collected or used. Client users have a separate **Client portal** login tab and distinct account role.

## Authentication and authorization

The API hashes passwords with bcrypt, issues an HTTP-only, SameSite=Strict session cookie, enforces an eight-hour session by default, rate-limits repeated failed logins, reloads account status and role on each protected request, and rejects inactive accounts. All protected routes verify the session; admin routes check the admin role. Staff task queries are scoped to their assigned tasks, client task queries to their own client profile, and message routes enforce participant and client ownership checks. Admin access cannot be removed from the final active admin.

Without MongoDB, authentication and account management use a private local JSON account store, and tasks, clients, notifications, conversations, and messages use a separate private JSON workspace store. Staff and clients receive API-scoped task/conversation data; client task updates and messages are restricted to their assigned client identity. MongoDB is optional for local use and can be enabled with `MONGODB_URI` for database persistence. Employee capability profiles still require MongoDB. Do not use local JSON mode as a shared production deployment.

## Database and configuration

The backend loads environment variables from the project-root `.env` using `dotenv/config`. The file is ignored by Git. Set a unique random `JWT_SECRET` (32+ characters), and put the Atlas connection string in `MONGODB_URI` using this shape: `mongodb+srv://<db-user>:<url-encoded-password>@<cluster-host>/<database>?retryWrites=true&w=majority`. Replace the placeholders locally; do not paste credentials into React code or commit `.env`. URL-encode special characters in the database username/password. In Atlas, create a database user and allow the machine/server IP in Network Access.

Keep `PORT=4000` for the current Vite proxy in `vite.config.js`; the frontend sends `/api` calls to that port. Set `CLIENT_ORIGIN` to the browser origin. For separate production or preview origins, add their exact URLs as a comma-separated `ALLOWED_ORIGINS` value; do not use a wildcard. API health is at [http://localhost:4000/api/health](http://localhost:4000/api/health) and returns HTTP 200 with `{ "success": true, "database": "connected" }` when MongoDB is connected. If a configured connection fails, the API logs a redacted error and does not start. If `MONGODB_URI` is blank, local JSON fallback remains available and health reports that MongoDB is not configured. If Node reports an SRV DNS error such as `EBADRESP` while `dig` succeeds, set `MONGODB_DNS_SERVERS=8.8.8.8,8.8.4.4` in `.env` to make the backend use Google DNS for SRV lookups, or use the standard non-SRV URI copied from Atlas.

Existing task, profile, messaging, notification, and activity models and route handlers remain in `server/index.js`; no duplicate DB module or test model is needed. Existing MongoDB users are migrated to username accounts using the former email local part as an initial username. Legacy inactive accounts remain blocked until an admin activates them.

## Build and verification

```sh
npm run build
```

The API supports protected task, notification, employee-profile, and conversation endpoints. Client account provisioning is admin-only and client login uses a separate endpoint.

## Employee device alerts

When a task is created or reassigned, the assigned employee receives an in-app notification and a web push on each device where they enabled alerts. The API checks every minute for tasks due in about 24 hours and sends one reminder per task. Admins can also send an alert to one active employee or all active employees from **Notifications**.

On each employee device, sign in, open **Notifications**, choose **Enable device alerts**, and allow the browser prompt. The API server must be running for assignment pushes, scheduled reminders, and manual broadcasts. The .env contains VAPID public/private keys; the public key is sent to the browser during subscription, while the private key must remain server-only. Configure the same VAPID settings in the production API environment. Browser push requires HTTPS in deployment; localhost is supported for development. A LAN URL using plain HTTP may not support push subscriptions.
