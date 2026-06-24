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

## Using a custom domain later

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
