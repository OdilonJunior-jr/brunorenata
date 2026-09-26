const server = require('../server');
module.exports = async function handler(req, res) {
  const parsed = new URL(req.url || '/api/admin-action', `https://${req.headers.host || 'localhost'}`);
  const id = String(parsed.searchParams.get('id') || '').replace(/\D/g, '');
  const action = String(parsed.searchParams.get('action') || '');
  if (!id) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'ID ausente.' }));
  }
  if (req.method === 'DELETE') {
    req.url = `/api/admin/requests/${id}`;
  } else if (action === 'status') {
    req.url = `/api/admin/requests/${id}/status`;
  } else if (action === 'notes') {
    req.url = `/api/admin/requests/${id}/notes`;
  } else {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'Ação inválida.' }));
  }
  return server.handleApiRequest(req, res);
};
