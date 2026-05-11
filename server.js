const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ─── Shared npm cache for lightning reinstalls ───
const NPM_CACHE = path.join(__dirname, 'npm-cache');
fs.mkdirSync(NPM_CACHE, { recursive: true });

// ─── In‑memory stores ───
const projects = new Map();   // id → { files }
const builds = new Map();     // id → { status, logs, outputDir }

app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// ─── API: create project ───
app.post('/api/projects', (req, res) => {
  const { files } = req.body;
  if (!files || typeof files !== 'object') return res.status(400).json({ error: 'Missing files object' });
  const id = uuidv4();
  projects.set(id, { files, createdAt: Date.now() });
  res.json({ id });
});

app.get('/api/projects/:id', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  res.json({ files: p.files });
});

// ─── Build process – uses static build (MIME‑free), shared npm cache ───
function startBuild(id) {
  const project = projects.get(id);
  if (!project) return;
  if (builds.has(id) && builds.get(id).status === 'building') return;

  const entry = { status: 'building', logs: [], outputDir: null };
  builds.set(id, entry);

  const tmpDir = path.join(__dirname, 'builds', id);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Patch vite.config.js for relative base and host
  const viteConfigKey = Object.keys(project.files).find(f => f === 'vite.config.js');
  if (viteConfigKey) {
    let config = project.files[viteConfigKey];
    // base: './'
    if (!config.includes('base:')) config = config.replace(/(defineConfig\(\s*\{)/, '$1\n  base: "./",');
    // allowedHosts
    if (!config.includes('allowedHosts')) {
      if (config.includes('server:')) config = config.replace(/server\s*:\s*\{/, 'server: { allowedHosts: true,');
      else config = config.replace(/(defineConfig\(\s*\{)/, '$1\n  server: { allowedHosts: true },');
    }
    project.files[viteConfigKey] = config;
  }

  Object.entries(project.files).forEach(([filePath, content]) => {
    const full = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  });

  const log = (line) => entry.logs.push(line);
  const env = { ...process.env, NODE_ENV: 'development', npm_config_cache: NPM_CACHE };

  const install = spawn('npm', ['install', '--prefer-offline'], { cwd: tmpDir, env, shell: true });
  install.stdout.on('data', d => log(d.toString()));
  install.stderr.on('data', d => log(d.toString()));

  install.on('close', (code) => {
    if (code !== 0) {
      entry.status = 'error';
      entry.logs.push('npm install failed');
      return;
    }
    const pkgPath = path.join(tmpDir, 'package.json');
    let buildCmd = ['npm', 'run', 'build'];
    if (!fs.existsSync(pkgPath)) {
      // No build step, just serve files
      entry.status = 'ready';
      entry.outputDir = tmpDir;
      entry.logs.push('Static site ready');
      app.use(`/preview/${id}`, express.static(tmpDir));
      return;
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!pkg.scripts?.build) {
      entry.status = 'ready';
      entry.outputDir = tmpDir;
      entry.logs.push('No build script – serving directly');
      app.use(`/preview/${id}`, express.static(tmpDir));
      return;
    }
    const build = spawn('npm', ['run', 'build'], { cwd: tmpDir, env, shell: true });
    build.stdout.on('data', d => log(d.toString()));
    build.stderr.on('data', d => log(d.toString()));

    build.on('close', (bc) => {
      if (bc !== 0) {
        entry.status = 'error';
        entry.logs.push('Build failed');
        return;
      }
      const out = fs.existsSync(path.join(tmpDir, 'dist'))
        ? path.join(tmpDir, 'dist')
        : fs.existsSync(path.join(tmpDir, 'build'))
          ? path.join(tmpDir, 'build')
          : tmpDir;
      entry.status = 'ready';
      entry.outputDir = out;
      entry.logs.push('Build complete');
      app.use(`/preview/${id}`, express.static(out));
    });
  });
}

// ─── API: trigger build ───
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

// ─── Loading page while building ───
app.get('/preview/:id', (req, res) => {
  const id = req.params.id;
  const b = builds.get(id);
  if (b && b.status === 'ready' && b.outputDir) {
    // Static files already mounted, serve index.html
    res.sendFile(path.join(b.outputDir, 'index.html'));
  } else if (projects.has(id)) {
    if (!b || b.status !== 'building') startBuild(id);
    res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Loading...</title>
<style>body{margin:0;background:#0d0d0d;color:#e0e0e0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column}.spinner{width:60px;height:60px;border:6px solid #333;border-top:6px solid #3b82f6;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:20px}@keyframes spin{to{transform:rotate(360deg)}}h2{margin-bottom:5px}p{color:#aaa}</style>
<script>const id='${id}';setInterval(async()=>{try{const r=await fetch('/api/projects/'+id+'/logs');const d=await r.json();if(d.status==='ready')window.location.reload()}catch(e){}},1500)</script>
</head><body><div class="spinner"></div><h2>🚀 Building preview...</h2><p>Installing dependencies, compiling...</p></body></html>`);
  } else {
    res.status(404).send('Project not found');
  }
});

// Dashboard
const clientDist = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Cache‑build engine on port ${PORT}`));
