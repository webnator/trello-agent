import * as http from "node:http";
import { getAllProjects } from "./projects.js";
import { getAllTasks } from "./task-store.js";
import { getHtml } from "./dashboard-html.js";

const startTime = Date.now();
let server: http.Server | null = null;

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function htmlResponse(res: http.ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.method !== "GET") {
    jsonResponse(res, { error: "Method not allowed" }, 405);
    return;
  }

  // Routes
  if (path === "/") {
    htmlResponse(res, getHtml());
    return;
  }

  if (path === "/api/projects") {
    const projects = getAllProjects();
    const result = projects.map((p) => {
      const tasks = getAllTasks(p.name);
      return {
        name: p.name,
        githubOwner: p.githubOwner,
        githubRepo: p.githubRepo,
        vercelUrl: p.vercelUrl || null,
        taskCount: tasks.length,
      };
    });
    jsonResponse(res, result);
    return;
  }

  // Match /api/projects/:name/tasks
  const taskMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks$/);
  if (taskMatch) {
    const projectName = decodeURIComponent(taskMatch[1]);
    const tasks = getAllTasks(projectName);
    jsonResponse(res, tasks);
    return;
  }

  if (path === "/api/status") {
    const projects = getAllProjects();
    let totalTasks = 0;
    for (const p of projects) {
      totalTasks += getAllTasks(p.name).length;
    }
    jsonResponse(res, {
      uptime: Math.floor((Date.now() - startTime) / 1000),
      projects: projects.length,
      totalTasks,
    });
    return;
  }

  jsonResponse(res, { error: "Not found" }, 404);
}

export function startDashboard(): void {
  const port = parseInt(process.env.DASHBOARD_PORT || "3000", 10);
  server = http.createServer(handleRequest);
  server.listen(port, () => {
    console.log(`Dashboard: http://localhost:${port}`);
  });
}

export function stopDashboard(): void {
  if (server) {
    server.close();
    server = null;
  }
}
