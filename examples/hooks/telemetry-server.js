#!/usr/bin/env node
/**
 * Simple telemetry webhook server for tweakcc events
 *
 * Usage:
 *   node telemetry-server.js
 *
 * Config:
 * {
 *   "id": "telemetry",
 *   "events": ["tool:before", "tool:after", "stream:end"],
 *   "type": "webhook",
 *   "webhook": "http://localhost:9000/events",
 *   "enabled": true
 * }
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 9000;
const LOG_FILE = process.env.LOG_FILE || path.join(process.env.HOME, '.tweakcc', 'telemetry.jsonl');

// Ensure log directory exists
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/events') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const event = JSON.parse(body);

        // Add server timestamp
        event.receivedAt = new Date().toISOString();

        // Log to console
        console.log(`[${event.event}] ${event.toolName || ''} @ ${event.timestamp}`);

        // Append to JSONL file
        fs.appendFileSync(LOG_FILE, JSON.stringify(event) + '\n');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (e) {
        console.error('Parse error:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/events') {
    // Return recent events
    try {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = content.trim().split('\n').slice(-100); // Last 100 events
      const events = lines.map(line => JSON.parse(line));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(events, null, 2));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy' }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Telemetry server running on http://localhost:${PORT}`);
  console.log(`  POST /events  - Receive events`);
  console.log(`  GET  /events  - View recent events`);
  console.log(`  GET  /health  - Health check`);
  console.log(`\nLogging to: ${LOG_FILE}`);
});
