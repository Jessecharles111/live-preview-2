import { useState } from 'react';
import PreviewEngine from './PreviewEngine';

export default function App() {
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadProject = async () => {
    if (!projectId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) throw new Error('Project not found');
      setReady(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-title">AI Web App Preview Engine</h1>
      </header>
      <div className="id-bar">
        <input
          type="text"
          placeholder="Paste project ID"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="id-input"
        />
        <button onClick={loadProject} disabled={loading} className="id-btn">
          {loading ? 'Loading…' : 'Preview'}
        </button>
      </div>
      {error && <p className="error-msg">{error}</p>}
      {ready && <PreviewEngine projectId={projectId} />}
    </div>
  );
}
