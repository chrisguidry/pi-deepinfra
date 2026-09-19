import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));
const SKILL_DIR = join(SKILLS_DIR, "deepinfra-models");

function load() {
  return loadSkillsFromDir({ dir: SKILLS_DIR, source: "package" });
}

// A skill pi will not load is a skill nobody reads, and the failure is silent:
// pi warns and moves on. Running the real loader is the only way to catch a bad
// frontmatter field before a user does.
test("pi loads the bundled skill without diagnostics", () => {
  const { skills, diagnostics } = load();

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(skills.map((skill) => skill.name), ["deepinfra-models"]);
});

test("the skill is offered to the model", () => {
  const { skills } = load();
  const rendered = formatSkillsForPrompt(skills, "read");

  assert.match(rendered, /<name>deepinfra-models<\/name>/);
  assert.equal(skills[0].disableModelInvocation, false);
});

// The description is the only part of a skill that is always in the prompt, so
// it is the part with a budget. Everything else loads on demand.
test("the description stays inside its prompt budget", () => {
  const { skills } = load();

  assert.ok(skills[0].description.length < 700, `description is ${skills[0].description.length} chars`);
});

// The skill tells the agent to run scripts by relative path. Renaming one would
// otherwise leave instructions pointing at nothing.
test("every file the skill mentions exists", () => {
  const mentioned = [];
  for (const document of ["SKILL.md", "reference.md"]) {
    const text = readFileSync(join(SKILL_DIR, document), "utf8");
    for (const match of text.matchAll(/(?:scripts\/[\w.-]+\.mjs|reference\.md)/g)) {
      mentioned.push({ document, path: match[0] });
    }
  }

  assert.ok(mentioned.length > 0, "no script paths found in the skill documents");
  for (const { document, path } of mentioned) {
    assert.ok(existsSync(join(SKILL_DIR, path)), `${document} points at a missing ${path}`);
  }
});
