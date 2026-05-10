const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ─── In‑memory stores ───
const projects = new Map();
const builds = new Map();   // id → { status, logs, previewUrl, outputDir }

// COOP/COEP headers
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

// ─── Build a project (will be called by API or preview route) ───
function startBuild(id) {
  const project = projects.get(id);
  if (!project) return;

  if (builds.has(id) && builds.get(id).status === 'building') return;

  builds.set(id, { status: 'building', logs: [], previewUrl: null, outputDir: null });

  const tmpDir = path.join(__dirname, 'builds', id);
  fs.mkdirSync(tmpDir, { recursive: true });

  Object.entries(project.files).forEach(([filePath, content]) => {
    const fullPath = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  });

  const log = (line) => {
    const b = builds.get(id);
    if (b) b.logs.push(line);
  };

  const env = { ...process.env, NODE_ENV: 'development' };
  const install = spawn('npm', ['install'], { cwd: tmpDir, env, shell: true });
  install.stdout.on('data', (data) => log(data.toString()));
  install.stderr.on('data', (data) => log(data.toString()));

  install.on('close', (code) => {
    if (code !== 0) {
      builds.set(id, { ...builds.get(id), status: 'error', logs: [...builds.get(id).logs, 'npm install failed'] });
      return;
    }

    const pkgPath = path.join(tmpDir, 'package.json');
    let buildCmd = null;
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.build) buildCmd = ['npm', 'run', 'build'];
      else if (pkg.scripts?.dev) buildCmd = ['npm', 'run', 'dev', '--', '--host', '0.0.0.0'];
      else buildCmd = ['npx', 'vite', 'build'];
    } else {
      // No package.json – serve files directly from the project root
      const outDir = tmpDir;
      builds.set(id, { status: 'ready', logs: [...builds.get(id).logs, 'No build needed'], previewUrl: `/preview/${id}`, outputDir: outDir });
      return;
    }

    const build = spawn(buildCmd[0], buildCmd.slice(1), { cwd: tmpDir, env, shell: true });
    build.stdout.on('data', (data) => log(data.toString()));
    build.stderr.on('data', (data) => log(data.toString()));

    build.on('close', (buildCode) => {
      if (buildCode !== 0) {
        builds.set(id, { ...builds.get(id), status: 'error', logs: [...builds.get(id).logs, 'Build failed'] });
        return;
      }
      const outputDir = fs.existsSync(path.join(tmpDir, 'dist')) ? path.join(tmpDir, 'dist') :
                         fs.existsSync(path.join(tmpDir, 'build')) ? path.join(tmpDir, 'build') : tmpDir;
      builds.set(id, { status: 'ready', logs: [...builds.get(id).logs, 'Build complete'], previewUrl: `/preview/${id}`, outputDir });
    });
  });
}

// ─── API: trigger build explicitly ───
app.get('/api/projects/:id/build', (req, res) => {
  if (!projects.has(req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const b = builds.get(req.params.id);
  if (b && b.status === 'ready') return res.json({ url: `/preview/${req.params.id}`, status: 'ready' });
  startBuild(req.params.id);
  res.json({ url: `/preview/${req.params.id}`, status: 'building' });
});

// ─── API: get logs ───
app.get('/api/projects/:id/logs', (req, res) => {
  const build = builds.get(req.params.id);
  if (!build) return res.json({ logs: [], status: 'idle' });
  res.json({ logs: build.logs, status: build.status, url: build.previewUrl });
});

// ─── PREVIEW SERVING (THE FIX) ───
app.use('/preview/:id', (req, res, next) => {
  const id = req.params.id;
  const build = builds.get(id);
  if (build && build.status === 'ready' && build.outputDir) {
    // Serve the static files directly from the build output directory
    express.static(build.outputDir)(req, res, next);
  } else if (projects.has(id)) {
    // Build hasn't finished yet – start it if not already building
    if (!build || build.status !== 'building') {
      startBuild(id);
    }
    res.status(202).send('Build in progress, refresh in a moment…');
  } else {
    // Unknown project – fall through to dashboard
    next();
  }
});

// ─── Dashboard static files (the React app) ───
const clientDist = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
