const server = require('../server');

module.exports = async function handler(req, res) {
  const originalUrl = req.url || '';
  const parsed = new URL(
    originalUrl,
    `https://${req.headers.host || 'localhost'}`
  );

  const route =
    parsed.searchParams.get('path') ||
    req.query?.path ||
    '';

  const normalizedRoute = Array.isArray(route)
    ? route.join('/')
    : String(route);

  req.url = `/api/${normalizedRoute}`;

  return server.handleApiRequest(req, res);
};
