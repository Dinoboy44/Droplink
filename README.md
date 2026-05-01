# DropLink

Real file sharing with expiring links. No login, no database, no BS.

Upload a file → get a link → anyone with the link can download → file auto-deletes.

---

## Folder Structure

```
droplink/
├── server.js          ← Express backend (all API logic)
├── package.json
├── .env.example       ← Copy to .env for local config
├── render.yaml        ← One-click Render deployment
├── .gitignore
├── uploads/           ← Auto-created. Files stored here. Git-ignored.
└── public/
    └── index.html     ← Complete frontend (upload + download UI)
```

---

## Run Locally

### 1. Install dependencies

```bash
cd droplink
npm install
```

### 2. Configure (optional)

```bash
cp .env.example .env
# Edit .env if you want to change port, expiry time, etc.
# Defaults work fine for local dev — no changes needed.
```

### 3. Start the server

```bash
npm start
```

Or with auto-restart on file changes:

```bash
npm run dev
```

### 4. Open in browser

```
http://localhost:3000
```

Upload a file, copy the generated link, open it in another tab or on another device (on the same network) — it works.

---

## API Endpoints

### `POST /upload`
Upload a file.

**Form fields:**
- `file` (required) — the file to upload
- `expiryHours` (optional) — override expiry, default from env

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "link": "https://yourapp.com/file/550e8400-e29b-41d4-a716-446655440000",
  "fileName": "report.pdf",
  "size": 204800,
  "expiresAt": 1700000000000
}
```

---

### `GET /file/:id`
Download a file. Returns the raw file with `Content-Disposition: attachment`.

- `200` — file stream
- `404` — file not found
- `410` — file expired and deleted

---

### `GET /info/:id`
Get file metadata without downloading.

**Response:**
```json
{
  "fileName": "report.pdf",
  "size": 204800,
  "mimeType": "application/pdf",
  "expiresAt": 1700000000000,
  "uploadedAt": 1699978400000
}
```

---

## Deploy to Render (free tier)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Render detects `render.yaml` automatically
5. After first deploy, set `BASE_URL` in environment variables to your Render URL  
   e.g. `https://droplink.onrender.com`
6. Redeploy — done

> **Note:** Render free tier spins down after inactivity. Upgrade to paid ($7/mo) for always-on.  
> The `render.yaml` mounts a persistent disk at `/app/uploads` so files survive restarts.

---

## Deploy to Railway

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Then set environment variables in the Railway dashboard:
- `BASE_URL` → your Railway app URL
- `EXPIRY_HOURS` → e.g. `6`
- `MAX_FILE_MB` → e.g. `100`

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `BASE_URL` | `http://localhost:3000` | Public URL (used in generated links) |
| `EXPIRY_HOURS` | `6` | Hours until file is deleted |
| `MAX_FILE_MB` | `100` | Max upload size in MB |

---

## How Expiry Works

1. On upload, `expiresAt = now + EXPIRY_HOURS * 3600000` is stored in memory
2. A cleanup interval runs every 5 minutes — any expired entries are deleted from disk and memory
3. On every download request, the server checks `expiresAt` before serving — expired files return `410 Gone`
4. On server restart, orphaned files in `uploads/` older than `EXPIRY_HOURS` are cleaned up

**Limitation:** The file registry is in-memory. A server restart clears it — existing links won't work after restart. See optional improvements below.

---

## Optional Improvements

These are deliberately left out to keep the MVP minimal:

### 1. Persist the registry (survive restarts)
Replace the in-memory `fileRegistry` object with a JSON file on disk:

```js
// On upload: write registry to disk
fs.writeFileSync('./registry.json', JSON.stringify(fileRegistry));

// On boot: load it
const fileRegistry = fs.existsSync('./registry.json')
  ? JSON.parse(fs.readFileSync('./registry.json'))
  : {};
```

Or use SQLite with the `better-sqlite3` package for proper persistence.

### 2. Download count / view tracking
Add a `downloads: 0` field to each registry entry and increment on each `/file/:id` hit.

### 3. Password protection
Add an optional password field on upload. Store bcrypt hash. Require it on download.

### 4. Multiple file upload
Change `upload.single('file')` to `upload.array('files', 10)` and loop.

### 5. S3 / Cloudflare R2 storage
Replace the local disk storage in Multer with `multer-s3` to store files in cloud object storage — essential for multi-instance deployments.

### 6. Rate limiting
Add `express-rate-limit` to prevent abuse:
```js
const rateLimit = require('express-rate-limit');
app.use('/upload', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
```
