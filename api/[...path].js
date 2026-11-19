import { app } from '../server/index.js';

// Vite and the Express API share one Vercel project. All /api/* requests are
// forwarded to the existing Express routes in server/index.js.
export default app;
