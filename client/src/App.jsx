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
    <div className="container">
      <h1>🚀 AI Web App Preview Engine</h1>
      <div className="input-row">
        <input
          type="text"
          placeholder="Enter project ID"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        />
        <button onClick={loadProject} disabled={loading}>
          {loading ? 'Loading...' : 'Load & Preview'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {ready && <PreviewEngine projectId={projectId} files={{}} />}
    </div>
  );
}
