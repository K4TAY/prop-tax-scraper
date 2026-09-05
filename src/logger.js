// Simple event-based logger for streaming console output to clients (same pattern as bexar)

class Logger {
  constructor() {
    this.clients = new Set();
    this.logs = [];
    this.maxLogs = 2000;
  }

  addClient(res) {
    this.clients.add(res);
    this.logs.forEach((log) => this.sendToClient(res, log));
  }

  removeClient(res) {
    this.clients.delete(res);
  }

  sendToClient(client, log) {
    try {
      client.write(`data: ${JSON.stringify(log)}\n\n`);
    } catch {
      this.clients.delete(client);
    }
  }

  log(message, level = "info", source = "system") {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      source,
      message: String(message),
    };

    this.logs.push(logEntry);
    if (this.logs.length > this.maxLogs) this.logs.shift();

    for (const client of this.clients) {
      this.sendToClient(client, logEntry);
    }

    const timestamp = new Date().toLocaleTimeString();
    const prefix = `[${timestamp}] [${source.toUpperCase()}]`;
    switch (level) {
      case "error":
        console.error(`${prefix} ${message}`);
        break;
      case "warn":
        console.warn(`${prefix} ${message}`);
        break;
      case "success":
        console.log(`${prefix} ✅ ${message}`);
        break;
      default:
        console.log(`${prefix} ${message}`);
    }
  }

  info(message, source = "system") {
    this.log(message, "info", source);
  }

  error(message, source = "system") {
    this.log(message, "error", source);
  }

  success(message, source = "system") {
    this.log(message, "success", source);
  }

  warn(message, source = "system") {
    this.log(message, "warn", source);
  }

  clear() {
    this.logs = [];
    const clearEntry = {
      timestamp: new Date().toISOString(),
      level: "system",
      source: "system",
      message: "CLEAR_LOGS",
    };
    for (const client of this.clients) {
      this.sendToClient(client, clearEntry);
    }
  }

  getRecentLogs(limit = 100) {
    return this.logs.slice(-limit);
  }
}

const logger = new Logger();
export default logger;
