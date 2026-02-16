import * as fs from "fs";
import * as path from "path";
import type { ProjectConfig, ProjectRegistry } from "../types.js";

function getProjectsFilePath(): string {
  if (process.env.PROJECTS_FILE) {
    return process.env.PROJECTS_FILE;
  }
  const home = process.env.HOME || "/root";
  return path.join(home, ".trello-agent", "projects.json");
}

let cachedRegistry: ProjectRegistry | null = null;

export function loadRegistry(): ProjectRegistry {
  if (cachedRegistry) return cachedRegistry;

  const filePath = getProjectsFilePath();

  if (!fs.existsSync(filePath)) {
    // Return empty registry if file doesn't exist
    cachedRegistry = { projects: {} };
    return cachedRegistry;
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    cachedRegistry = JSON.parse(content) as ProjectRegistry;
    return cachedRegistry;
  } catch (err) {
    console.error(`Failed to load projects registry from ${filePath}:`, err);
    cachedRegistry = { projects: {} };
    return cachedRegistry;
  }
}

export function saveRegistry(registry: ProjectRegistry): void {
  const filePath = getProjectsFilePath();
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(registry, null, 2));
  cachedRegistry = registry;
}

export function getProject(name: string): ProjectConfig | undefined {
  const registry = loadRegistry();
  return registry.projects[name];
}

export function getAllProjects(): ProjectConfig[] {
  const registry = loadRegistry();
  return Object.values(registry.projects);
}

export function addProject(config: ProjectConfig): void {
  const registry = loadRegistry();
  registry.projects[config.name] = config;

  // Set as default if it's the first project
  if (Object.keys(registry.projects).length === 1) {
    registry.defaultProject = config.name;
  }

  saveRegistry(registry);
}

export function getDefaultProject(): ProjectConfig | undefined {
  const registry = loadRegistry();
  if (registry.defaultProject) {
    return registry.projects[registry.defaultProject];
  }
  // Fall back to first project if no default set
  const projects = Object.values(registry.projects);
  return projects.length > 0 ? projects[0] : undefined;
}

export function hasProjects(): boolean {
  const registry = loadRegistry();
  return Object.keys(registry.projects).length > 0;
}

export function updateProjectUrl(name: string, vercelUrl: string): boolean {
  const registry = loadRegistry();
  const project = registry.projects[name];

  if (!project) {
    return false;
  }

  project.vercelUrl = vercelUrl;
  saveRegistry(registry);
  return true;
}
