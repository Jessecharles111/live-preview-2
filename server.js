const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ─── Shared pnpm store for mega‑speed ───
const PNPM_STORE = path.join(__dirname, 'pnpm-store');
fs.mkdirSync(PNPM_STORE, { recursive: true });

// ─── State ───
const projects = new Map();   // id → { files }
const sessions = new Map();   // id → { status, logs, port, process, lastUsed }

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

// ─── Launch dev server with base path injection ───
function startDevServer(id) {
  const project = projects.get(id);
  if (!project) return;
  if (sessions.has(id) && sessions.get(id).status === 'running') return;

  const session = { status: 'starting', logs: [], port: null, process: null, lastUsed: Date.now() };
  sessions.set(id, session);

  const tmpDir = path.join(__dirname, 'builds', id);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Patch vite.config.js: add base + server.allowedHosts + host
  const viteConfigKey = Object.keys(project.files).find(f => f === 'vite.config.js' || f === 'vite.config.ts');
  if (viteConfigKey) {
    let config = project.files[viteConfigKey];
    // base: '/preview/ID/'
    config = config.replace(/(defineConfig\(\s*\{)/, `$1\n  base: '/preview/${id}/',`);
    // server: { allowedHosts: true, host: '0.0.0.0' }
    if (!config.includes('allowedHosts')) {
      config = config.replace(/server\s*:\s*\{/, 'server: { allowedHosts: true, host: "0.0.0.0",');
    }
    if (!config.includes('host:')) {
      config = config.replace(/server\s*:\s*\{/, 'server: { host: "0.0.0.0",');
    }
    project.files[viteConfigKey] = config;
  }

  // Write all files
  Object.entries(project.files).forEach(([f, c]) => {
    const fp = path.join(tmpDir, f);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, c, 'utf8');
  });

  const log = (line) => session.logs.push(line);
  const env = { ...process.env, NODE_ENV: 'development' };

  // Use pnpm if available, else npm
  const installer = spawn('which', ['pnpm']);
  installer.on('close', (code) => {
    const usePnpm = code === 0;
    const cmd = usePnpm ? 'pnpm' : 'npm';
    const args = usePnpm
      ? ['install', '--store-dir', PNPM_STORE, '--offline']
      : ['install', '--prefer-offline', '--cache', path.join(__dirname, 'npm-cache')];

    const install = spawn(cmd, args, { cwd: tmpDir, env, shell: true });
    install.stdout.on('data', d => log(d.toString()));
    install.stderr.on('data', d => log(d.toString()));

    install.on('close', (code) => {
      if (code !== 0) {
        session.status = 'error';
        session.logs.push('Install failed');
        return;
      }

      const pkgPath = path.join(tmpDir, 'package.json');
      let startCmd = ['npm', 'run', 'dev', '--', '--host', '0.0.0.0', '--port', '0'];
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (!pkg.scripts?.dev) {
          startCmd = ['npx', 'serve', '.', '-l', '0'];
        }
      }

      const dev = spawn(startCmd[0], startCmd.slice(1), { cwd: tmpDir, env, shell: true });
      session.process = dev;

      let portResolved = false;
      dev.stdout.on('data', (data) => {
        const str = data.toString();
        log(str);
        if (!portResolved) {
          const match = str.match(/http:\/\/localhost:(\d+)/);
          if (match) {
            session.port = parseInt(match[1], 10);
            portResolved = true;
            session.status = 'running';
            log(`✅ Dev server live on port ${session.port}`);
          }
        }
      });
      dev.stderr.on('data', d => log(d.toString()));
      dev.on('close', () => {
        if (!portResolved) session.status = 'error';
        else session.status = 'stopped';
      });
    });
  });
}

// ─── Cleanup old sessions after 10 minutes ───
setInterval(() => {
  const now = Date.now();
  sessions.forEach((s, id) => {
    if (s.status === 'running' && s.process && now - s.lastUsed > 10 * 60 * 1000) {
      s.process.kill();
      sessions.delete(id);
      projects.delete(id);
      fs.rmSync(path.join(__dirname, 'builds', id), { recursive: true, force: true });
    }
  });
}, 5 * 60 * 1000);

// ─── API: start preview ───
app.get('/api/projects/:id/preview', (req, res) => {
  const id = req.params.id;
  if (!projects.has(id)) return res.status(404).json({ error: 'Project not found' });
  const s = sessions.get(id);
  if (s && s.status === 'running') {
    s.lastUsed = Date.now();
    return res.json({ url: `/preview/${id}`, status: 'ready' });
  }
  startDevServer(id);
  res.json({ url: `/preview/${id}`, status: 'starting' });
});

// ─── API: logs ───
app.get('/api/projects/:id/logs', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({ logs: [], status: 'idle' });
  res.json({ logs: s.logs, status: s.status, url: s.port ? `/preview/${req.params.id}` : null });
});

// ─── Proxy /preview/:id/* directly to Vite (no stripping – Vite knows base) ───
app.use('/preview/:id', (req, res, next) => {
  const id = req.params.id;
  const session = sessions.get(id);
  if (!session || session.status !== 'running' || !session.port) return next();

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: session.port,
    path: req.url,           // Keep the full /preview/ID/... path
    method: req.method,
    headers: { ...req.headers, host: `localhost:${session.port}` }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => next());
  req.pipe(proxyReq);
});

// ─── Loading page for /preview/:id ───
app.get('/preview/:id', (req, res, next) => {
  const id = req.params.id;
  const session = sessions.get(id);
  if (session?.status === 'running') return next(); // let proxy handle
  if (projects.has(id)) {
    if (!session || session.status !== 'starting') startDevServer(id);
    return res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Loading...</title>
<style>body{margin:0;background:#0d0d0d;color:#e0e0e0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column}.spinner{width:60px;height:60px;border:6px solid #333;border-top:6px solid #3b82f6;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:20px}@keyframes spin{to{transform:rotate(360deg)}}h2{margin-bottom:5px}p{color:#aaa}</style>
<script>const id='${id}';setInterval(async()=>{try{const r=await fetch('/api/projects/'+id+'/logs');const d=await r.json();if(d.status==='running')window.location.reload()}catch(e){}},1500)</script>
</head><body><div class="spinner"></div><h2>🚀 Starting preview...</h2><p>Installing packages, booting dev server…</p></body></html>`);
  }
  next();
});

// Dashboard
const clientDist = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Ultra‑fast engine on port ${PORT}`));
