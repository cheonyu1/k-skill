const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("hwp skill documents environment-aware routing and supported operations", () => {
  const skillPath = path.join(repoRoot, "hwp", "SKILL.md");

  assert.ok(fs.existsSync(skillPath), "expected hwp/SKILL.md to exist");

  const skill = read(path.join("hwp", "SKILL.md"));

  assert.match(skill, /^name: hwp$/m);
  assert.match(skill, /@ohah\/hwpjs/);
  assert.match(skill, /\bhwp-mcp\b/);
  assert.match(skill, /Windows/i);
  assert.match(skill, /JSON/i);
  assert.match(skill, /Markdown/i);
  assert.match(skill, /HTML/i);
  assert.match(skill, /image/i);
  assert.match(skill, /batch/i);
});

test("hwp skill documents inline image verification for markdown output", () => {
  const skill = read(path.join("hwp", "SKILL.md"));

  assert.match(skill, /hwpjs to-markdown document\.hwp -o output\.md --include-images/);
  assert.match(skill, /Markdown:.*(data:|base64)/);
  assert.doesNotMatch(skill, /Markdown:.*이미지 경로 생성 여부 확인/);
});

test("repository docs advertise the hwp skill", () => {
  const readme = read("README.md");
  const install = read(path.join("docs", "install.md"));
  const featureDocPath = path.join(repoRoot, "docs", "features", "hwp.md");
  const featureDoc = read(path.join("docs", "features", "hwp.md"));

  assert.ok(fs.existsSync(featureDocPath), "expected docs/features/hwp.md to exist");
  assert.match(readme, /\| HWP 문서 처리 \|/);
  assert.match(readme, /\[HWP 문서 처리\]\(docs\/features\/hwp\.md\)/);
  assert.match(install, /--skill hwp/);
  assert.match(featureDoc, /--include-images/);
  assert.match(featureDoc, /(data:|base64)/);
});
