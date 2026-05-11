const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// In‑memory stores
const projects = new Map();          // id → { files }
const builds = new Map();            // id → { status, logs, outputDir }

// Headers (required for SharedArrayBuffer etc.)
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// ─── API: create project ───
app.post('/api/projects', (req, res) => {
  const { files } = req.body;
  if (!files || typeof files !== 'object')
    return res.status(400).json({ error: 'Missing files object' });
  const id = uuidv4();
  projects.set(id, { files, createdAt: Date.now() });
  res.json({ id });
});

app.get('/api/projects/:id', (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ files: project.files });
});

// ─── Build process (called from API or preview route) ───
function startBuild(id) {
  const project = projects.get(id);
  if (!project) return;
  if (builds.has(id) && builds.get(id).status === 'building') return;

  const buildEntry = { status: 'building', logs: [], outputDir: null };
  builds.set(id, buildEntry);

  const tmpDir = path.join(__dirname, 'builds', id);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Write all project files, BUT patch vite.config.js to force relative base
  const viteConfigKey = Object.keys(project.files).find(f => f === 'vite.config.js');
  if (viteConfigKey) {
    // Insert relative base into the config object
    let configContent = project.files[viteConfigKey];
    // Try to add base: './' after the first '{' inside defineConfig
    configContent = configContent.replace(
      /(defineConfig\(\s*\{)/,
      '$1\n  base: "./",'
    );
    project.files[viteConfigKey] = configContent;
  }

  Object.entries(project.files).forEach(([filePath, content]) => {
    const fullPath = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  });

  const log = (line) => buildEntry.logs.push(line);

  const env = { ...process.env, NODE_ENV: 'development' };
  const install = spawn('npm', ['install'], { cwd: tmpDir, env, shell: true });
  install.stdout.on('data', d => log(d.toString()));
  install.stderr.on('data', d => log(d.toString()));

  install.on('close', (code) => {
    if (code !== 0) {
      builds.set(id, { ...buildEntry, status: 'error', logs: [...buildEntry.logs, 'npm install failed'] });
      return;
    }
    const pkgPath = path.join(tmpDir, 'package.json');
    let buildCmd = null;
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      buildCmd = pkg.scripts?.build ? ['npm', 'run', 'build'] : ['npm', 'run', 'dev', '--', '--host', '0.0.0.0'];
    } else {
      // No package.json – just serve files directly (static site)
      const outDir = tmpDir;
      builds.set(id, { status: 'ready', logs: [...buildEntry.logs, 'Static site ready'], outputDir: outDir });
      // Mount static middleware AFTER setting outputDir
      app.use(`/preview/${id}`, express.static(outDir));
      return;
    }
    const build = spawn(buildCmd[0], buildCmd.slice(1), { cwd: tmpDir, env, shell: true });
    build.stdout.on('data', d => log(d.toString()));
    build.stderr.on('data', d => log(d.toString()));

    build.on('close', (bc) => {
      if (bc !== 0) {
        builds.set(id, { ...buildEntry, status: 'error', logs: [...buildEntry.logs, 'Build failed'] });
        return;
      }
      const outDir = fs.existsSync(path.join(tmpDir, 'dist'))
        ? path.join(tmpDir, 'dist')
        : fs.existsSync(path.join(tmpDir, 'build'))
          ? path.join(tmpDir, 'build')
          : tmpDir;
      builds.set(id, { status: 'ready', logs: [...buildEntry.logs, 'Build complete'], outputDir: outDir });
      // Dynamically mount the static files for this preview
      app.use(`/preview/${id}`, express.static(outDir));
    });
  });
}

// ─── API: trigger build explicitly ───
app.get('/api/projects/:id/build', (req, res) => {
  if (!projects.has(req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const b = builds.get(req.params.id);
  if (b?.status === 'ready') return res.json({ url: `/preview/${req.params.id}`, status: 'ready' });
  startBuild(req.params.id);
  res.json({ url: `/preview/${req.params.id}`, status: 'building' });
});

// ─── API: logs ───
app.get('/api/projects/:id/logs', (req, res) => {
  const b = builds.get(req.params.id);
  if (!b) return res.json({ logs: [], status: 'idle' });
  res.json({ logs: b.logs, status: b.status, url: b.outputDir ? `/preview/${req.params.id}` : null });
});

// ─── Beautiful loading page (shown when build not yet ready) ───
function loadingPage(id) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Building preview...</title>
  <style>
    body { margin:0; background:#0d0d0d; color:#e0e0e0; font-family:system-ui,sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; flex-direction:column; }
    .spinner { width:60px; height:60px; border:6px solid #333; border-top:6px solid #3b82f6; border-radius:50%; animation:spin 0.8s linear infinite; margin-bottom:20px; }
    @keyframes spin { to { transform:rotate(360deg); } }
    h2 { margin-bottom:5px; }
    p { color:#aaa; }
  </style>
  <script>
    const id = '${id}';
    setInterval(async () => {
      try {
        const r = await fetch('/api/projects/' + id + '/logs');
        const data = await r.json();
        if (data.status === 'ready') window.location.reload();
      } catch(e) {}
    }, 2000);
  </script>
</head>
<body>
  <div class="spinner"></div>
  <h2>🚀 Building your preview</h2>
  <p>Installing dependencies, compiling…</p>
</body>
</html>`;
}

// ─── Preview route (catch GET /preview/:id and serve loading page or let static middleware handle) ───
app.get('/preview/:id', (req, res, next) => {
  const id = req.params.id;
  const build = builds.get(id);
  if (build && build.status === 'ready' && build.outputDir) {
    // Static middleware will handle this, just pass to next (express.static already mounted)
    next();
  } else if (projects.has(id)) {
    if (!build || build.status !== 'building') startBuild(id);
    res.send(loadingPage(id));
  } else {
    next(); // unknown project, fall through to dashboard
  }
});

// ─── Dashboard (the React client) ───
const clientDist = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
