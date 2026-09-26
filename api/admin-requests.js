const server = require('../server');
module.exports = async function handler(req, res) {
  return server.handleApiRoute(req, res, '/api/admin/requests');
};
