const server = require('../server');
const handleApiRequest = server.handleApiRequest;

module.exports = async function handler(req, res) {
  const value = req.query?.path;
  const route = Array.isArray(value) ? value.join('/') : String(value || '');
  req.url = `/api/${route}`;
  return handleApiRequest(req, res);
};
