# My Permanent Blog

A simple personal blog app built with Node.js, Express, and SQLite.

## Running locally

Install dependencies and start the server:

```bash
npm install
node server.js
```

Then open:

```bash
http://127.0.0.1:3000
```

## Deploying to Render

This project is already configured for Render with a `render.yaml` file and a Dockerfile.

1. Push this repo to GitHub.
2. In Render, click New + > Web Service.
3. Connect the GitHub repo.
4. Keep the default settings or use the existing `render.yaml` config.
5. Add environment variables in Render if you want cloud storage and email support:
   - `TURSO_URL`
   - `TURSO_AUTH_TOKEN`
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
   - `ADMIN_OVERRIDE_CODE` (optional)
6. Click Create Web Service.

Render will start the app with the existing Node/start command and expose it on a public URL.

## Running on your laptop too

To run the same app locally on your laptop:

```bash
npm install
node server.js
```

Then open:

```text
http://127.0.0.1:3000
```

## Important note on data

If you want both your laptop and Render to share the same entries and settings, use a shared cloud database such as Turso. Without `TURSO_URL`/`TURSO_AUTH_TOKEN`, the app falls back to local SQLite files in `data/`, which means each machine keeps its own local data.

For a custom domain later

When you are ready to make the site public, deploy it on a server and point your domain to that server.

1. Buy a domain from a registrar such as Namecheap, Google Domains, or GoDaddy.
2. Deploy this app to a public host or VPS.
3. Set your domain DNS records:
   - `A` record for `yourdomain.com` -> your server IP
   - `CNAME` record for `www.yourdomain.com` -> `yourdomain.com`
4. Start the app with a host that accepts external connections:

```bash
PORT=3000 HOST=0.0.0.0 node server.js
```

5. Use HTTPS with a certificate provider like Let's Encrypt or your host's managed SSL service.

## Configuration

The app supports these environment variables:

- `PORT` — the listening port (default: `3000`)
- `HOST` — the listening host (default: `127.0.0.1`)

A public deployment typically uses `HOST=0.0.0.0` so the app accepts connections from outside the local machine.

## Notes

- If you use a reverse proxy such as Nginx or Caddy, route traffic to the app on `http://127.0.0.1:3000`.
- Keep the admin password safe and do not share it publicly.
