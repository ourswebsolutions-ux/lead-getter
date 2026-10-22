'use strict';

// PM2 service for the Lead Finder licence server, next to the subscription
// website on the same machine: pm2 start deploy/ecosystem.config.js
// Settings come from server/.env (see .env.example and deploy/README.md).
module.exports = {
  apps: [
    {
      name: 'lead-getter-licence',
      script: 'src/index.js',
      cwd: require('node:path').join(__dirname, '..'),
      node_args: '--env-file=.env',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      env: { NODE_ENV: 'production' },
    },
  ],
};
