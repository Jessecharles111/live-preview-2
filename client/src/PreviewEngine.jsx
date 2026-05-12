import { useEffect, useState, useRef } from 'react';

export default function PreviewEngine({ projectId }) {
  const [status, setStatus] = useState('idle');     // idle | building | running | error
  const [logs, setLogs] = useState([]);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [showLogs, setShowLogs] = useState(false);
  const logEndRef = useRef(null);
  const iframeRef = useRef(null);

  useEffect(() => {
    if (!projectId) return;
    setStatus('building');
    setLogs([]);
    setPreviewUrl(null);

    fetch(`/api/projects/${projectId}/preview`)
      .then(r => r.json())
      .then(data => {
        if (data.status === 'ready') {
          setPreviewUrl(`/preview/${projectId}`);
          setStatus('running');
        } else {
          const poll = setInterval(() => {
            fetch(`/api/projects/${projectId}/logs`)
              .then(r => r.json())
              .then(build => {
                setLogs(build.logs);
                if (build.status === 'running') {
                  setPreviewUrl(`/preview/${projectId}`);
                  setStatus('running');
                  clearInterval(poll);
                } else if (build.status === 'error') {
                  setStatus('error');
                  clearInterval(poll);
                }
              });
          }, 1500);
          return () => clearInterval(poll);
        }
      })
      .catch(err => {
        setStatus('error');
        setLogs([`Connection error: ${err.message}`]);
      });
  }, [projectId]);

  // Auto‑scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, showLogs]);

  return (
    <div className="preview-container">
      {/* Status bar */}
      <div className="preview-status">
        <span className="status-dot" style={{
          background: status === 'running' ? '#10b981' :
                      status === 'building' ? '#f59e0b' : '#ef4444'
        }}></span>
        <span className="status-text">
          {status === 'running' ? 'Live preview' :
           status === 'building' ? 'Installing dependencies & starting dev server…' :
           status === 'error' ? 'Build failed' : 'Preparing…'}
        </span>
      </div>

      {/* Preview area */}
      {status === 'building' && !previewUrl ? (
        <div className="loading-view">
          <div className="spinner"></div>
          <p className="loading-msg">Building your app…</p>
        </div>
      ) : previewUrl ? (
        <iframe
          ref={iframeRef}
          src={previewUrl}
          sandbox="allow-scripts allow-same-origin"
          title="live preview"
          className="preview-iframe"
        />
      ) : (
        <div className="loading-view">
          <p>Waiting for preview…</p>
        </div>
      )}

      {/* Logs drawer (collapsible) */}
      <div className={`logs-drawer ${showLogs ? 'open' : ''}`}>
        <button className="logs-toggle" onClick={() => setShowLogs(!showLogs)}>
          {showLogs ? '▼ Hide logs' : '▲ Show logs'}
        </button>
        {showLogs && (
          <div className="logs-body">
            {logs.length === 0 ? (
              <p className="log-line empty">No activity yet…</p>
            ) : (
              logs.map((line, i) => (
                <div key={i} className="log-line">{line}</div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        )}
      </div>
    </div>
  );
}
