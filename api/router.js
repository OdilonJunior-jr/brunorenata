const server = require('../server');

module.exports = async function handler(req, res) {
  let route = req.query?.path;

  if (Array.isArray(route)) route = route.join('/');
  route = String(route || '').replace(/^\/+|\/+$/g, '');

  // Fallback para ambientes onde o parâmetro do rewrite não vier em req.query.
  if (!route) {
    const candidates = [
      req.headers['x-forwarded-uri'],
      req.headers['x-original-uri'],
      req.headers['x-rewrite-url'],
      req.url
    ].filter(Boolean);

    for (const candidate of candidates) {
      try {
        const parsed = new URL(String(candidate), `https://${req.headers.host || 'localhost'}`);
        const pathname = parsed.pathname.replace(/^\/+|\/+$/g, '');
        if (pathname.startsWith('api/') && pathname !== 'api/router') {
          route = pathname.slice(4);
          break;
        }
      } catch {}
    }
  }

  req.url = `/api/${route}`;
  return server.handleApiRequest(req, res);
};
