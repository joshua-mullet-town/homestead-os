const http = require('http');

const PHONE_API_HOST = process.env.PHONE_API_HOST || '100.84.84.102';
const PHONE_API_PORT = Number(process.env.PHONE_API_PORT || 8888);

function fetchHealth({ host = PHONE_API_HOST, port = PHONE_API_PORT, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          /* not JSON */
        }
        resolve({
          reachable: true,
          status_code: res.statusCode,
          body: parsed ?? data,
          host,
          port,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => {
      resolve({ reachable: false, error: err.message, host, port });
    });
  });
}

module.exports = { fetchHealth, PHONE_API_HOST, PHONE_API_PORT };
