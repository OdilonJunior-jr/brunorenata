const server = require('../server');
module.exports = async function handler(req, res) {
  req.url = '/api/admin/login';
  return server.handleApiRequest(req, res);
};
