const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const projects = new Map();
const builds = new Map();

app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// ---------- API ----------
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

function startBuild(id) {
  const project = projects.get(id);
  if (!project) return;
  if (builds.has(id) && builds.get(id).status === 'building') return;

  builds.set(id, { status: 'building', logs: [], outputDir: null });

  const tmpDir = path.join(__dirname, 'builds', id);
  fs.mkdirSync(tmpDir, { recursive: true });

  Object.entries(project.files).forEach(([p, c]) => {
    const fp = path.join(tmpDir, p);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, c, 'utf8');
  });

  const log = line => {
    const b = builds.get(id);
    if (b) b.logs.push(line);
  };

  const env = { ...process.env, NODE_ENV: 'development' };
  const install = spawn('npm', ['install'], { cwd: tmpDir, env, shell: true });
  install.stdout.on('data', d => log(d.toString()));
  install.stderr.on('data', d => log(d.toString()));
  install.on('close', code => {
    if (code !== 0) {
      builds.set(id, { ...builds.get(id), status: 'error', logs: [...builds.get(id).logs, 'npm install failed'] });
      return;
    }
    const pkgPath = path.join(tmpDir, 'package.json');
    let buildCmd = null;
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      buildCmd = pkg.scripts?.build ? ['npm','run','build'] : ['npm','run','dev','--','--host','0.0.0.0'];
    } else {
      builds.set(id, { status: 'ready', logs: [...builds.get(id).logs, 'No build needed'], outputDir: tmpDir });
      return;
    }
    const b = spawn(buildCmd[0], buildCmd.slice(1), { cwd: tmpDir, env, shell: true });
    b.stdout.on('data', d => log(d.toString()));
    b.stderr.on('data', d => log(d.toString()));
    b.on('close', bc => {
      if (bc !== 0) {
        builds.set(id, { ...builds.get(id), status: 'error', logs: [...builds.get(id).logs, 'Build failed'] });
        return;
      }
      const out = fs.existsSync(path.join(tmpDir, 'dist')) ? path.join(tmpDir, 'dist') :
                  fs.existsSync(path.join(tmpDir, 'build')) ? path.join(tmpDir, 'build') : tmpDir;
      builds.set(id, { status: 'ready', logs: [...builds.get(id).logs, 'Build complete'], outputDir: out });
    });
  });
}

app.get('/api/projects/:id/build', (req, res) => {
  if (!projects.has(req.params.id)) return res.status(404).json({ error: 'Project not found' });
  const b = builds.get(req.params.id);
  if (b?.status === 'ready') return res.json({ url: `/preview/${req.params.id}`, status: 'ready' });
  startBuild(req.params.id);
  res.json({ url: `/preview/${req.params.id}`, status: 'building' });
});

app.get('/api/projects/:id/logs', (req, res) => {
  const b = builds.get(req.params.id);
  if (!b) return res.json({ logs: [], status: 'idle' });
  res.json({ logs: b.logs, status: b.status, url: b.outputDir ? `/preview/${req.params.id}` : null });
});

// ---------- PREVIEW ROUTE (loading page when building, static files when ready) ----------
app.get('/preview/:id', (req, res) => {
  const id = req.params.id;
  const build = builds.get(id);
  if (build && build.status === 'ready' && build.outputDir) {
    // serve static files from build directory
    return res.sendFile(path.join(build.outputDir, 'index.html'));
  }
  if (projects.has(id)) {
    if (!build || build.status !== 'building') startBuild(id);
    // Serve a beautiful loading page that auto-refreshes
    return res.send(`
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
    // Poll every 2 seconds, reload when ready
    const id = '${id}';
    setInterval(async () => {
      try {
        const r = await fetch('/api/projects/' + id + '/logs');
        const data = await r.json();
        if (data.status === 'ready') {
          window.location.reload();
        }
      } catch(e) {}
    }, 2000);
  </script>
</head>
<body>
  <div class="spinner"></div>
  <h2>🚀 Building your preview</h2>
  <p>Installing dependencies, compiling...</p>
</body>
</html>`);
  }
  // unknown project
  res.status(404).send('Project not found');
});

// Dashboard
const clientDist = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
