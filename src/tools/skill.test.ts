import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills } from "./skill.js";

function writeSkill(
  dir: string,
  name: string,
  description: string,
  body = "",
): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
  );
}

const roots: string[] = [];
function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), "sp-skills-"));
  roots.push(root);
  return root;
}

describe("discoverSkills", () => {
  it("discovers Claude Code skills from ~/.claude/skills", () => {
    const home = tempHome();
    writeSkill(join(home, ".claude", "skills"), "commit", "make a commit");

    const skills = discoverSkills(home, null);

    expect(skills.get("commit")?.description).toBe("make a commit");
  });

  it("lets a native .stackpilot skill override a borrowed .claude skill of the same name", () => {
    const home = tempHome();
    writeSkill(join(home, ".claude", "skills"), "slack", "borrowed");
    writeSkill(join(home, ".stackpilot", "skills"), "slack", "native");

    const skills = discoverSkills(home, null);

    expect(skills.get("slack")?.description).toBe("native");
  });

  it("lets a project skill override a user skill of the same name", () => {
    const home = tempHome();
    const gitRoot = tempHome();
    writeSkill(join(home, ".claude", "skills"), "review", "user-level");
    writeSkill(join(gitRoot, ".claude", "skills"), "review", "project-level");

    const skills = discoverSkills(home, gitRoot);

    expect(skills.get("review")?.description).toBe("project-level");
  });

  it("resolves symlinked skill directories (Claude Code's common layout)", () => {
    const home = tempHome();
    const external = tempHome();
    writeSkill(external, "ti", "linked skill", "body text");
    const claudeSkills = join(home, ".claude", "skills");
    mkdirSync(claudeSkills, { recursive: true });
    symlinkSync(join(external, "ti"), join(claudeSkills, "ti"));

    const skills = discoverSkills(home, null);

    expect(skills.get("ti")?.description).toBe("linked skill");
    expect(skills.get("ti")?.content).toBe("body text");
  });

  it("returns an empty map when no skill dirs exist", () => {
    const home = tempHome();
    expect(discoverSkills(home, null).size).toBe(0);
  });
});
