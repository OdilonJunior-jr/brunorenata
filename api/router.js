const server = require('../server');

module.exports = async function handler(req, res) {
  let route = req.query && req.query.path;
  if (Array.isArray(route)) route = route.join('/');
  route = String(route || '').replace(/^\/+|\/+$/g, '');

  if (!route) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'Caminho da API ausente.' }));
  }

  req.url = `/api/${route}`;
  return server.handleApiRequest(req, res);
};
