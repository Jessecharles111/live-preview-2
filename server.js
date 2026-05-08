const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// In-memory project store (swap with a free DB later)
const projects = new Map();

// ---------- API endpoints ----------
app.post('/api/projects', (req, res) => {
  const { files } = req.body; // files: { "index.html": "...", ... }
  if (!files || typeof files !== 'object') {
    return res.status(400).json({ error: 'Missing files object' });
  }
  const id = uuidv4();
  projects.set(id, { files, createdAt: Date.now() });
  res.json({ id });
});

app.get('/api/projects/:id', (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ files: project.files });
});

// ---------- Serve built React app ----------
const clientDistPath = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientDistPath));

// COOP/COEP headers for all responses (required by NanoVM)
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// Fallback to index.html for client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Browser Preview Engine running on port ${PORT}`);
});
