# ARC-AI Client

Frontend for ARC-AI — a provider-agnostic AI workspace with conversational voice, live vision, and realtime streaming.

Built with React 19 + Vite + styled-components, connected to the backend over **Socket.IO** and **REST**.

## Environment

Create `.env` in this directory if your backend is not at `http://localhost:5000`:

```env
VITE_API_URL=http://localhost:5000
VITE_APP_URL=http://localhost:5173
```

## Scripts

```bash
npm install
npm run dev        # local dev server (HMR)
npm run build      # production build
npm run lint       # ESLint
npm run preview    # preview production build
```

## Voice state-machine tests

```bash
node scripts/testVoiceMachine.js   # Advanced Voice state machine regression tests
```

## Deployment (Vercel)

The app is an SPA. `vercel.json` already configures:

- SPA rewrites (all routes → `index.html`, except sitemap/robots)
- Security headers (CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy, COOP)
- `/public/sitemap.xml` and `/public/robots.txt` redirects

Set `VITE_API_URL` to your backend URL as a Vercel environment variable and rebuild.

See the repository root `README.md` for full setup, backend, and architecture documentation.