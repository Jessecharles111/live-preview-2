const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'client', 'dist')));

// In‑memory stores
const projects = new Map();          // id → { files, createdAt }
const builds = new Map();            // id → { status, logs, previewUrl }

// COOP/COEP headers (needed if we ever use SharedArrayBuffer)
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// ─── API: create project ───
app.post('/api/projects', (req, res) => {
  const { files } = req.body;
  if (!files || typeof files !== 'object') {
    return res.status(400).json({ error: 'Missing files object' });
  }
  const id = uuidv4();
  projects.set(id, { files, createdAt: Date.now() });
  res.json({ id });
});

// ─── API: get project files (needed by frontend) ───
app.get('/api/projects/:id', (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ files: project.files });
});

// ─── API: build project and stream logs ───
app.get('/api/projects/:id/build', (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const buildId = req.params.id;
  // If already built, just return the static URL
  if (builds.has(buildId) && builds.get(buildId).status === 'ready') {
    return res.json({ url: `/preview/${buildId}`, status: 'ready' });
  }

  // Initialize build record
  builds.set(buildId, { status: 'building', logs: [], previewUrl: null });

  // Create a temporary directory for this build
  const tmpDir = path.join(__dirname, 'builds', buildId);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Write all project files
  Object.entries(project.files).forEach(([filePath, content]) => {
    const fullPath = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  });

  // Determine package manager and build script
  const pkgPath = path.join(tmpDir, 'package.json');
  let buildCmd = null;
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.scripts?.build) buildCmd = ['npm', 'run', 'build'];
    else if (pkg.scripts?.dev) buildCmd = ['npm', 'run', 'dev', '--', '--host', '0.0.0.0']; // fallback
    else buildCmd = ['npx', 'vite', 'build']; // guess
  } else {
    // No package.json -> just treat it as static files, no build needed
    builds.set(buildId, { status: 'ready', logs: [], previewUrl: `/preview/${buildId}` });
    return res.json({ url: `/preview/${buildId}`, status: 'ready' });
  }

  // Run npm install first
  const install = spawn('npm', ['install'], { cwd: tmpDir, shell: true });
  const log = (line) => {
    builds.get(buildId).logs.push(line);
  };

  install.stdout.on('data', (data) => log(data.toString()));
  install.stderr.on('data', (data) => log(data.toString()));

  install.on('close', (code) => {
    if (code !== 0) {
      builds.set(buildId, { ...builds.get(buildId), status: 'error', logs: [...builds.get(buildId).logs, 'npm install failed'] });
      return;
    }
    // Now run the build
    const build = spawn(buildCmd[0], buildCmd.slice(1), { cwd: tmpDir, shell: true });
    build.stdout.on('data', (data) => log(data.toString()));
    build.stderr.on('data', (data) => log(data.toString()));

    build.on('close', (buildCode) => {
      if (buildCode !== 0) {
        builds.set(buildId, { ...builds.get(buildId), status: 'error', logs: [...builds.get(buildId).logs, 'Build failed'] });
        return;
      }
      // Build succeeded – serve the output directory (dist, build, or .)
      const outputDir = fs.existsSync(path.join(tmpDir, 'dist'))
        ? 'dist' : fs.existsSync(path.join(tmpDir, 'build')) ? 'build' : '.';
      app.use(`/preview/${buildId}`, express.static(path.join(tmpDir, outputDir)));
      builds.set(buildId, { status: 'ready', logs: [...builds.get(buildId).logs, 'Build complete'], previewUrl: `/preview/${buildId}` });
    });
  });

  // Send the build status and URL immediately (will be checked via polling)
  res.json({ url: `/preview/${buildId}`, status: 'building' });
});

// ─── API: get build logs (polling endpoint) ───
app.get('/api/projects/:id/logs', (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) return res.json({ logs: [], status: 'idle' });
  res.json({ logs: build.logs, status: build.status, url: build.previewUrl });
});

// Fallback to client app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
