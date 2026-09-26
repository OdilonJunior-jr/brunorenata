const server = require('../server');
module.exports = async function handler(req, res) {
  req.url = '/api/admin/logout';
  return server.handleApiRequest(req, res);
};
