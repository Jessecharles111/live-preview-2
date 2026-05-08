import { useEffect, useRef, useState } from 'react';
import { NanoVM } from 'nanovm';

export default function PreviewEngine({ files }) {
  const iframeRef = useRef(null);
  const termContainerRef = useRef(null);
  const [status, setStatus] = useState('booting');
  const [previewUrl, setPreviewUrl] = useState(null);
  const vmRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const vm = new NanoVM({
      terminal: true,
      iframe: true,
      term: { container: termContainerRef.current },
    });
    vmRef.current = vm;

    (async () => {
      try {
        // 1. Boot Linux + Node.js
        setStatus('booting');
        await vm.boot();
        if (cancelled) return;

        // 2. Write project files to virtual FS
        setStatus('writing files');
        for (const [filePath, content] of Object.entries(files)) {
          await vm.fs.writeFile(filePath, content);
        }

        // 3. Install npm dependencies
        setStatus('installing dependencies');
        await vm.runCommand('npm install');

        // 4. Start dev server (detect type)
        setStatus('starting dev server');
        const pkgJson = files['package.json'];
        const hasVite = pkgJson && pkgJson.includes('"vite"');
        const startCmd = hasVite ? 'npm run dev' : 'npx serve .';
        vm.runCommand(startCmd);

        // 5. Wait for HTTP server readiness and capture the URL
        vm.on('http-up', (url) => {
          if (!cancelled) {
            setPreviewUrl(url);
            setStatus('running');
          }
        });

        // Also listen for errors
        vm.on('error', (err) => {
          if (!cancelled) setStatus('error: ' + err.message);
        });
      } catch (err) {
        if (!cancelled) setStatus('fatal: ' + err.message);
      }
    })();

    return () => {
      cancelled = true;
      vm?.destroy();
    };
  }, [files]);

  return (
    <div className="preview-layout">
      <div className="terminal-panel" ref={termContainerRef} />
      <div className="preview-panel">
        <div className="status-bar">
          Status: <strong>{status}</strong>
        </div>
        {previewUrl ? (
          <iframe
            ref={iframeRef}
            src={previewUrl}
            sandbox="allow-scripts allow-same-origin"
            title="live preview"
            className="preview-iframe"
          />
        ) : (
          <div className="loading-placeholder">
            {status === 'running' ? 'Waiting for server...' : 'Preparing environment...'}
          </div>
        )}
      </div>
    </div>
  );
}
