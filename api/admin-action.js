const server = require('../server');
module.exports = async function handler(req, res) {
  const id = String((req.query && req.query.id) || '').replace(/\D/g, '');
  const action = String((req.query && req.query.action) || '');
  if (!id) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'ID invalido.' }));
  }
  let route = `/api/admin/requests/${id}`;
  if (action === 'status') route += '/status';
  if (action === 'notes') route += '/notes';
  return server.handleApiRoute(req, res, route);
};
