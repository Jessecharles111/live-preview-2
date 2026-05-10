import { useEffect, useState, useRef } from 'react';

export default function PreviewEngine({ files, projectId }) {
  const [status, setStatus] = useState('idle');
  const [logs, setLogs] = useState([]);
  const [previewUrl, setPreviewUrl] = useState(null);
  const logEndRef = useRef(null);

  useEffect(() => {
    if (!projectId) return;
    setStatus('building');
    setLogs([]);
    setPreviewUrl(null);

    // Start the build
    fetch(`/api/projects/${projectId}/build`)
      .then(res => res.json())
      .then(data => {
        if (data.status === 'ready') {
          setPreviewUrl(data.url);
          setStatus('ready');
        } else {
          // Poll for logs every 500ms
          const poll = setInterval(() => {
            fetch(`/api/projects/${projectId}/logs`)
              .then(r => r.json())
              .then(build => {
                setLogs(build.logs);
                if (build.status === 'ready') {
                  setPreviewUrl(build.url || `/preview/${projectId}`);
                  setStatus('ready');
                  clearInterval(poll);
                } else if (build.status === 'error') {
                  setStatus('error');
                  clearInterval(poll);
                }
              });
          }, 500);
          return () => clearInterval(poll);
        }
      })
      .catch(err => {
        setStatus('error');
        setLogs([`Connection error: ${err.message}`]);
      });
  }, [projectId, files]);

  // Auto‑scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="preview-layout">
      <div className="terminal-panel">
        <div className="status-bar">
          Status: <strong>{status === 'building' ? '⚙️ Building...' : status === 'ready' ? '✅ Ready' : '❌ Error'}</strong>
        </div>
        <div className="log-output">
          {logs.length === 0 && status === 'building' && <p>Starting build...</p>}
          {logs.map((line, i) => (
            <div key={i} className="log-line">{line}</div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>
      <div className="preview-panel">
        {previewUrl ? (
          <iframe
            src={previewUrl}
            sandbox="allow-scripts allow-same-origin"
            title="live preview"
            className="preview-iframe"
          />
        ) : (
          <div className="loading-placeholder">
            {status === 'building' ? 'Building project...' : 'Waiting for preview...'}
          </div>
        )}
      </div>
    </div>
  );
}
