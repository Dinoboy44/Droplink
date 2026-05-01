const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const EXPIRY_HOURS = Number(process.env.EXPIRY_HOURS) || 6;
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_MB) || 100;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ─── STORAGE ──────────────────────────────────────────────────────────────────
// In-memory store: { [fileId]: { originalName, storedName, mimeType, size, uploadedAt, expiresAt } }
// On restart this resets — see "Optional Improvements" in README for persistence.
const fileRegistry = {};

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── MULTER ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname) || '';
    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 }
});

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── ROUTES ───────────────────────────────────────────────────────────────────

/**
 * POST /upload
 * Accepts a single file via multipart form-data (field name: "file")
 * Returns: { id, link, fileName, size, expiresAt }
 */
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided.' });
  }

  // Extract the UUID from the stored filename (before the extension)
  const storedName = req.file.filename;
  const fileId = path.basename(storedName, path.extname(storedName));

  const now = Date.now();
  // Use expiry from request if provided, clamped to 15 min–24 hr range
  const requestedMinutes = parseFloat(req.body.expiryMinutes);
  const expiryMinutes = (!isNaN(requestedMinutes) && requestedMinutes >= 1 && requestedMinutes <= 1440)
    ? requestedMinutes
    : EXPIRY_HOURS * 60;
  const expiresAt = now + expiryMinutes * 60 * 1000;

  fileRegistry[fileId] = {
    originalName: req.file.originalname,
    storedName,
    mimeType: req.file.mimetype,
    size: req.file.size,
    uploadedAt: now,
    expiresAt
  };

  const link = `${BASE_URL}/file/${fileId}`;

  console.log(`[UPLOAD] ${req.file.originalname} → ${fileId} (expires ${new Date(expiresAt).toISOString()})`);

  return res.json({
    id: fileId,
    link,
    fileName: req.file.originalname,
    size: req.file.size,
    expiresAt
  });
});

/**
 * GET /file/:id
 * Streams the file to the client as a download.
 * Returns 404 if not found, 410 Gone if expired.
 */
app.get('/file/:id', (req, res) => {
  const { id } = req.params;

  // Validate: only allow UUID-shaped IDs (no path traversal)
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid file ID.' });
  }

  const meta = fileRegistry[id];
  if (!meta) {
    return res.status(404).json({ error: 'File not found.' });
  }

  if (Date.now() > meta.expiresAt) {
    deleteFile(id);
    return res.status(410).json({ error: 'Link expired. File has been deleted.' });
  }

  const filePath = path.join(UPLOADS_DIR, meta.storedName);
  if (!fs.existsSync(filePath)) {
    delete fileRegistry[id];
    return res.status(404).json({ error: 'File not found on disk.' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(meta.originalName)}"`);
  res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', meta.size);

  console.log(`[DOWNLOAD] ${meta.originalName} (${id})`);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', () => res.status(500).end());
});

/**
 * GET /info/:id
 * Returns file metadata (name, size, expiry) without downloading.
 * Used by the frontend to render the download page.
 */
app.get('/info/:id', (req, res) => {
  const { id } = req.params;

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Invalid file ID.' });
  }

  const meta = fileRegistry[id];
  if (!meta) return res.status(404).json({ error: 'File not found.' });

  if (Date.now() > meta.expiresAt) {
    deleteFile(id);
    return res.status(410).json({ error: 'Expired.' });
  }

  return res.json({
    fileName: meta.originalName,
    size: meta.size,
    mimeType: meta.mimeType,
    expiresAt: meta.expiresAt,
    uploadedAt: meta.uploadedAt
  });
});

// ─── CLEANUP ──────────────────────────────────────────────────────────────────
function deleteFile(id) {
  const meta = fileRegistry[id];
  if (!meta) return;

  const filePath = path.join(UPLOADS_DIR, meta.storedName);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[EXPIRE] Deleted ${meta.originalName} (${id})`);
    }
  } catch (err) {
    console.error(`[EXPIRE] Error deleting ${id}:`, err.message);
  }
  delete fileRegistry[id];
}

// Scan registry every 5 minutes and remove expired entries
setInterval(() => {
  const now = Date.now();
  let count = 0;
  for (const id of Object.keys(fileRegistry)) {
    if (now > fileRegistry[id].expiresAt) {
      deleteFile(id);
      count++;
    }
  }
  if (count > 0) console.log(`[CLEANUP] Removed ${count} expired file(s)`);
}, 5 * 60 * 1000);

// Also scan uploads/ folder on boot to clean up orphaned files from previous runs
(function cleanupOnBoot() {
  if (!fs.existsSync(UPLOADS_DIR)) return;
  const files = fs.readdirSync(UPLOADS_DIR);
  let removed = 0;
  for (const f of files) {
    const id = path.basename(f, path.extname(f));
    if (!fileRegistry[id]) {
      // Orphan — no registry entry, check file age
      const stat = fs.statSync(path.join(UPLOADS_DIR, f));
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > EXPIRY_HOURS * 60 * 60 * 1000) {
        fs.unlinkSync(path.join(UPLOADS_DIR, f));
        removed++;
      }
    }
  }
  if (removed > 0) console.log(`[BOOT] Cleaned ${removed} orphaned file(s)`);
})();

// ─── ERROR HANDLERS ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large. Max size is ${MAX_FILE_SIZE_MB}MB.` });
  }
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// 404 for unknown API routes
app.use('/upload', (req, res) => res.status(405).json({ error: 'Method not allowed.' }));
app.use('/file', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Fallback: serve index.html for any non-API route (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  DropLink running on ${BASE_URL}`);
  console.log(`  Files expire after ${EXPIRY_HOURS} hours`);
  console.log(`  Max upload size: ${MAX_FILE_SIZE_MB}MB\n`);
});
