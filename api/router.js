const server = require('../server');

module.exports = async function handler(req, res) {
  let route = req.query && req.query.path;

  if (Array.isArray(route)) route = route.join('/');
  route = String(route || '').replace(/^\/+|\/+$/g, '');

  // Fallback: em alguns runtimes a query pode permanecer só em req.url.
  if (!route) {
    try {
      const parsed = new URL(req.url || '', `https://${req.headers.host || 'localhost'}`);
      route = String(parsed.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
    } catch {}
  }

  if (!route) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'Rota da API não recebida pelo roteador.' }));
  }

  req.url = `/api/${route}`;
  return server.handleApiRequest(req, res);
};
