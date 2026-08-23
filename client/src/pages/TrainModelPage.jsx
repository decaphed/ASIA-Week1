import { useState } from 'react';
import Card, { CardLabel, buttonReset } from '../components/Card.jsx';
import { api } from '../api/client.js';

function MetricsTable({ title, metrics }) {
  if (!metrics) {
    return (
      <div style={{ flex: 1, minWidth: 240 }}>
        <CardLabel as="h3">{title}</CardLabel>
        <div style={{ padding: '18px 0', color: '#8a99a8', fontSize: 13 }}>No model currently deployed.</div>
      </div>
    );
  }
  return (
    <div style={{ flex: 1, minWidth: 240 }}>
      <CardLabel>{title}</CardLabel>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10, fontSize: 12.5 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#8a99a8', fontSize: 11, textTransform: 'uppercase' }}>
            <th style={{ padding: '4px 6px' }}>Class</th>
            <th style={{ padding: '4px 6px' }}>Precision</th>
            <th style={{ padding: '4px 6px' }}>Recall</th>
            <th style={{ padding: '4px 6px' }}>Support</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(metrics.perClass).map(([label, m]) => (
            <tr key={label} style={{ borderTop: '1px solid #eef2f5' }}>
              <td style={{ padding: '6px' }}>{label}</td>
              <td style={{ padding: '6px' }}>{m.precision.toFixed(2)}</td>
              <td style={{ padding: '6px' }}>{m.recall.toFixed(2)}</td>
              <td style={{ padding: '6px' }}>{m.support}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 10, fontSize: 12.5, color: '#5f6f7e' }}>
        Overall accuracy: <strong>{(metrics.overallAccuracy * 100).toFixed(1)}%</strong>
      </div>
    </div>
  );
}

export default function TrainModelPage({ showToast }) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [fitting, setFitting] = useState(false);
  const [fitResult, setFitResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resetCount, setResetCount] = useState(0);

  const reset = () => {
    setFile(null);
    setUploadResult(null);
    setFitResult(null);
    // Forces the (uncontrolled) file input to remount so its displayed
    // filename clears too — clearing `file` state alone doesn't touch what
    // the browser shows in the native file picker.
    setResetCount((n) => n + 1);
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setUploadResult(null);
    setFitResult(null);
    try {
      const res = await api.uploadTrainingCsv(file);
      setUploadResult({ ok: true, ...res.data });
    } catch (err) {
      setUploadResult({ ok: false, reasons: err.details?.reasons || [err.message], qualityScore: err.details?.qualityScore });
    } finally {
      setUploading(false);
    }
  };

  const handleFit = async () => {
    setFitting(true);
    try {
      const res = await api.fitTrainingCandidate(uploadResult.uploadId);
      setFitResult(res.data);
    } catch (err) {
      showToast(`Fit failed: ${err.message}`, '#B3282D');
    } finally {
      setFitting(false);
    }
  };

  const handleDeploy = async () => {
    if (!window.confirm('Deploy this candidate model? It will replace whatever is currently live.')) return;
    setBusy(true);
    try {
      await api.deployTrainingCandidate(uploadResult.uploadId);
      showToast('Candidate model deployed.', '#177E4D');
      reset();
    } catch (err) {
      showToast(`Deploy failed: ${err.message}`, '#B3282D');
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async () => {
    setBusy(true);
    try {
      await api.discardTrainingCandidate(uploadResult.uploadId);
      reset();
    } catch (err) {
      showToast(`Discard failed: ${err.message}`, '#B3282D');
    } finally {
      setBusy(false);
    }
  };

  const handleModelReset = async () => {
    if (!window.confirm('Reset the live model? Tier 2 detections stop until a new model is deployed.')) return;
    setBusy(true);
    try {
      await api.resetTrainingModel();
      // Invalidate the comparison table's "Currently deployed" column
      // specifically — don't call the full reset() here, that would also
      // wipe the upload/fit results and force the operator to re-upload.
      setFitResult(null);
      showToast('Live model reset — Tier 1 only until a new model is deployed.', '#8a99a8');
    } catch (err) {
      showToast(`Reset failed: ${err.message}`, '#B3282D');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: '20px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Train a new model</h2>
            <div style={{ fontSize: 12.5, color: '#8a99a8', marginTop: 3 }}>
              Upload a training CSV, review its quality report, fit a candidate, and compare it against the
              currently-deployed model before choosing to deploy it.
            </div>
          </div>
          <button
            type="button"
            className="hover-ghost"
            onClick={handleModelReset}
            disabled={busy}
            style={{ ...buttonReset, color: '#B3282D', borderRadius: 6, padding: '6px 12px', fontSize: 12.5, fontWeight: 600 }}
          >
            Reset live model
          </button>
        </div>
      </Card>

      <Card>
        <CardLabel>1. Upload training CSV</CardLabel>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
          <input key={resetCount} type="file" accept=".csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button
            type="button"
            className="hover-outline-btn"
            onClick={handleUpload}
            disabled={!file || uploading}
            style={{ ...buttonReset, border: '1px solid #1F3A6E', color: '#1F3A6E', background: '#ffffff', borderRadius: 6, padding: '6px 14px', fontSize: 12.5, fontWeight: 600, opacity: !file || uploading ? 0.5 : 1 }}
          >
            {uploading ? 'Uploading…' : 'Upload & check quality'}
          </button>
        </div>
        {uploadResult && !uploadResult.ok && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 6, background: '#FBEAEA', color: '#8a2222', fontSize: 12.5 }}>
            Rejected{uploadResult.qualityScore != null ? ` (score ${uploadResult.qualityScore})` : ''}:
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {uploadResult.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
        )}
        {uploadResult?.ok && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 6, background: '#EAF6EF', color: '#177E4D', fontSize: 12.5 }}>
            Passed — quality score {uploadResult.qualityScore}, {uploadResult.rowCount} rows.
          </div>
        )}
      </Card>

      {uploadResult?.ok && (
        <Card>
          <CardLabel>2. Fit a candidate model</CardLabel>
          {!fitResult && (
            <button
              type="button"
              className="hover-outline-btn"
              onClick={handleFit}
              disabled={fitting}
              style={{ ...buttonReset, marginTop: 10, border: '1px solid #1F3A6E', color: '#1F3A6E', background: '#ffffff', borderRadius: 6, padding: '6px 14px', fontSize: 12.5, fontWeight: 600, opacity: fitting ? 0.5 : 1 }}
            >
              {fitting ? 'Fitting…' : 'Fit candidate'}
            </button>
          )}
          {fitResult && (
            <>
              <div style={{ display: 'flex', gap: 24, marginTop: 14, flexWrap: 'wrap' }}>
                <MetricsTable title="Currently deployed" metrics={fitResult.deployedMetrics} />
                <MetricsTable title="Candidate (this upload)" metrics={fitResult.candidateMetrics} />
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                <button
                  type="button"
                  className="hover-outline-btn"
                  onClick={handleDeploy}
                  disabled={busy}
                  style={{ ...buttonReset, border: '1px solid #177E4D', color: '#177E4D', background: '#ffffff', borderRadius: 6, padding: '6px 14px', fontSize: 12.5, fontWeight: 600, opacity: busy ? 0.5 : 1 }}
                >
                  Deploy this model
                </button>
                <button
                  type="button"
                  className="hover-ghost"
                  onClick={handleDiscard}
                  disabled={busy}
                  style={{ ...buttonReset, color: '#8a99a8', borderRadius: 6, padding: '6px 14px', fontSize: 12.5, fontWeight: 600 }}
                >
                  Discard
                </button>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
