const server = require('../server');

module.exports = async function handler(req, res) {
  req.url = '/api/health';
  return server.handleApiRequest(req, res);
};
