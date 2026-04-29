/**
 * PM2: API (default 35184, see API_PORT) + Vite (1984). Survives closing the terminal.
 * Start: npm run pm2:start   Stop: npm run pm2:stop   Logs: npm run pm2:logs
 */
const path = require("path");

const root = __dirname;

module.exports = {
  apps: [
    {
      name: "mf-lab-api",
      script: path.join(root, "server/api.mjs"),
      cwd: root,
      interpreter: "node",
      node_args: "--env-file=.env",
      autorestart: true,
      max_restarts: 15,
      min_uptime: "4s",
      watch: [path.join(root, "server")],
      ignore_watch: ["node_modules", "data", "dist", ".git", ".mf-dev", "logs"],
    },
    {
      name: "mf-lab-vite",
      script: path.join(root, "node_modules/vite/bin/vite.js"),
      cwd: root,
      interpreter: "node",
      autorestart: true,
      max_restarts: 15,
      min_uptime: "4s",
      watch: [path.join(root, "vite.config.js")],
      ignore_watch: ["node_modules", "data", "dist", ".git", ".mf-dev"],
    },
  ],
};
