import { useEffect, useRef, useState } from 'react';

export default function PreviewEngine({ projectId }) {
  const [status, setStatus] = useState('idle');
  const [logs, setLogs] = useState([]);
  const [previewUrl, setPreviewUrl] = useState(null);
  const logEndRef = useRef(null);
  const iframeRef = useRef(null);

  useEffect(() => {
    if (!projectId) return;
    setStatus('building');
    setLogs([]);
    setPreviewUrl(null);

    // Trigger preview (will start dev server if needed)
    fetch(`/api/projects/${projectId}/preview`)
      .then(r => r.json())
      .then(data => {
        if (data.status === 'ready') {
          setPreviewUrl(`/preview/${projectId}`);
          setStatus('ready');
        } else {
          // Poll logs every 1.5s to see real‑time output
          const poll = setInterval(() => {
            fetch(`/api/projects/${projectId}/logs`)
              .then(r => r.json())
              .then(build => {
                setLogs(build.logs);
                if (build.status === 'running') {
                  setPreviewUrl(`/preview/${projectId}`);
                  setStatus('ready');
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

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="preview-layout">
      {/* Terminal panel */}
      <div className="terminal-panel">
        <div className="terminal-header">
          <span className="terminal-dot" style={{background:'#ff5f57'}}></span>
          <span className="terminal-dot" style={{background:'#febc2e'}}></span>
          <span className="terminal-dot" style={{background:'#28c840'}}></span>
          <span className="terminal-title">Build Logs</span>
        </div>
        <div className="terminal-body">
          {logs.length === 0 && status === 'building' && (
            <div className="loading-animation">
              <div className="bouncing-loader">
                <div></div><div></div><div></div>
              </div>
              <p>Installing packages...</p>
            </div>
          )}
          {logs.map((line, i) => (
            <div key={i} className="log-line">
              <span className="log-prompt">$</span> {line}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>

      {/* Preview panel */}
      <div className="preview-panel">
        <div className="preview-header">
          Status:{' '}
          <strong className={
            status === 'ready' ? 'status-ready' :
            status === 'building' ? 'status-building' : 'status-error'
          }>
            {status === 'ready' ? '✅ Live' : status === 'building' ? '⚙️ Building...' : '❌ Error'}
          </strong>
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
          <div className="preview-placeholder">
            {status === 'building' ? (
              <div className="pulse-ring"></div>
            ) : status === 'error' ? (
              <p>Build failed. Check logs.</p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
