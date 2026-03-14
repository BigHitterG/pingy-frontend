const express = require('express');
const cors = require('cors');

const app = express();
const PORT = Number(process.env.PORT || 8787);

app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
  const now = new Date().toISOString();
  console.log(`[pumpfun-adapter] ${now} ${req.method} ${req.originalUrl}`);
  next();
});

function errorResponse(res, error, statusCode = 400) {
  return res.status(statusCode).json({
    ok: false,
    error: String(error || 'Invalid request.'),
  });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function listTopLevelKeys(payload) {
  return payload && typeof payload === 'object' ? Object.keys(payload) : [];
}

function logRequestBodySummary(route, payload) {
  const keys = listTopLevelKeys(payload);
  const rowCount = Array.isArray(payload?.rows) ? payload.rows.length : undefined;
  const summary = {
    keys,
    ...(typeof rowCount === 'number' ? { rowCount } : {}),
  };
  console.log(`[pumpfun-adapter] ${route} body`, summary);
}

app.get('/health', (_req, res) => {
  return res.json({ ok: true, service: 'pumpfun-adapter' });
});

app.post('/api/pumpfun/launch', (req, res) => {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  logRequestBodySummary('/api/pumpfun/launch', payload);

  if (!isNonEmptyString(payload.roomId)) return errorResponse(res, 'roomId is required.');
  if (!isNonEmptyString(payload.name)) return errorResponse(res, 'name is required.');
  if (!isNonEmptyString(payload.symbol)) return errorResponse(res, 'symbol is required.');
  if (!isNonEmptyString(payload.creatorWallet)) return errorResponse(res, 'creatorWallet is required.');

  return res.json({
    ok: true,
    platform: 'pumpfun',
    status: 'submitted',
    url: '',
    mint: '',
    submitted_at: Date.now(),
    live_at: null,
    payload,
  });
});

app.post('/api/pumpfun/status', (req, res) => {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  logRequestBodySummary('/api/pumpfun/status', payload);
  const submittedAt = Number(payload.submitted_at || payload.submittedAt || payload.lastSubmittedAt || 0);

  return res.json({
    ok: true,
    platform: 'pumpfun',
    status: 'submitted',
    url: '',
    mint: '',
    submitted_at: Number.isFinite(submittedAt) && submittedAt > 0 ? submittedAt : Date.now(),
    live_at: null,
    tokens_received: 0,
    tokens_distributed: 0,
    distribution_status: 'pending',
    settlement_status: 'pending',
    settled_at: null,
    rows: [],
  });
});

app.post('/api/pumpfun/settlement', (req, res) => {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  logRequestBodySummary('/api/pumpfun/settlement', payload);
  const rows = Array.isArray(payload.rows) ? payload.rows : null;

  if (!isNonEmptyString(payload.roomId)) return errorResponse(res, 'roomId is required.');
  if (!isNonEmptyString(payload.mint)) return errorResponse(res, 'mint is required.');

  const recipientCount = Number(payload.recipientCount || 0);
  if (!Number.isFinite(recipientCount) || recipientCount < 1) {
    return errorResponse(res, 'recipientCount must be a positive number.');
  }

  if (!rows) return errorResponse(res, 'rows array is required.');

  const settledAt = Date.now();
  const normalizedRows = rows
    .filter((row) => row && typeof row === 'object' && isNonEmptyString(row.wallet))
    .map((row, index) => {
      const plannedTokens = Number(row.plannedTokens ?? row.planned_tokens ?? 0);
      const sentTokens = Number(row.sentTokens ?? row.sent_tokens ?? plannedTokens);
      return {
        wallet: String(row.wallet).trim(),
        planned_tokens: Number.isFinite(plannedTokens) && plannedTokens > 0 ? Math.floor(plannedTokens) : 0,
        sent_tokens: Number.isFinite(sentTokens) && sentTokens > 0 ? Math.floor(sentTokens) : 0,
        tx_id: `mock-settlement-${payload.roomId}-${index + 1}-${String(settledAt).slice(-6)}`,
        sent_at: settledAt,
        status: 'complete',
      };
    });

  return res.json({
    ok: true,
    platform: 'pumpfun',
    settlement_status: 'complete',
    settled_at: settledAt,
    rows: normalizedRows,
  });
});

app.listen(PORT, () => {
  console.log(`[pumpfun-adapter] listening on http://localhost:${PORT}`);
});
