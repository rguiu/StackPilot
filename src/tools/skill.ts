// Skill tool: loads SKILL.md files from project and user directories.
// Skills replace — calling Skill("x") unloads any previously loaded skill.
// Injected as a system-reminder in the next user message (preserves cache).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ToolDef, type ToolResult } from "./types.js";

export interface SkillInfo {
  name: string;
  description: string;
  content: string;
  location: string;
}

function parseFrontmatter(
  raw: string,
): { name: string; description: string } | null {
  const match = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!match || !match[1]) return null;
  const lines = match[1].split("\n");
  let name = "";
  let description = "";
  for (const line of lines) {
    const nameMatch = /^name:\s*(.+)/.exec(line);
    if (nameMatch?.[1]) name = nameMatch[1].trim();
    const descMatch = /^description:\s*(.+)/.exec(line);
    if (descMatch?.[1]) description = descMatch[1].trim();
  }
  if (!name) return null;
  return { name, description };
}

function readSkillsInDir(dir: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return skills;
  }
  for (const entry of entries) {
    const skillPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(skillPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const mdPath = join(skillPath, "SKILL.md");
    let raw: string;
    try {
      raw = readFileSync(mdPath, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    if (!fm) continue;
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    skills.push({
      name: fm.name,
      description: fm.description || "(no description)",
      content: body,
      location: mdPath,
    });
  }
  return skills;
}

export function discoverSkills(
  home: string,
  gitRoot: string | null,
): Map<string, SkillInfo> {
  const map = new Map<string, SkillInfo>();

  const userDir = join(home, ".stackpilot", "skills");
  for (const s of readSkillsInDir(userDir)) {
    map.set(s.name, s);
  }

  if (gitRoot) {
    const projectDir = join(gitRoot, ".stackpilot", "skills");
    for (const s of readSkillsInDir(projectDir)) {
      map.set(s.name, s); // project overrides user
    }
  }

  return map;
}

export function formatAvailableSkills(
  skills: ReadonlyMap<string, SkillInfo>,
): string {
  if (skills.size === 0) return "";
  const lines: string[] = [];
  lines.push("Available skills (invoke via the Skill tool or type /<name>):");
  for (const s of skills.values()) {
    lines.push(`- ${s.name}: ${s.description}`);
  }
  return lines.join("\n");
}

export function createSkillTool(skills: Map<string, SkillInfo>): ToolDef {
  return {
    name: "Skill",
    description:
      "Load a specialized skill when the task matches a skill's description. " +
      "Skills provide project-specific instructions. Use the name from the " +
      "available-skills list.",
    runPermitless: true,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "The skill name to load (from the available-skills list)",
        },
      },
      required: ["name"],
    },
    execute(input): Promise<ToolResult> {
      const name = input.name;
      if (typeof name !== "string" || name.length === 0) {
        return Promise.resolve({
          output: '"name" must be a non-empty string',
          isError: true,
        });
      }
      const skill = skills.get(name);
      if (!skill) {
        const available = [...skills.keys()].join(", ") || "(none)";
        return Promise.resolve({
          output: `unknown skill: ${name}. Available: ${available}`,
          isError: true,
        });
      }
      return Promise.resolve({
        output: `# ${skill.name}\n\n${skill.description}\n\n${skill.content}`,
      });
    },
  };
}
