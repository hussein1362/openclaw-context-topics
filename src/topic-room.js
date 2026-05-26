import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * @param {string} raw
 */
export function normalizeTopicName(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * @param {string} name
 */
export function isValidTopicName(name) {
  return /^[a-z0-9_-]+$/.test(name);
}

/**
 * @param {string} name
 */
export function humanizeTopicName(name) {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listTopicNames(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const topics = new Set();
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      const st = await stat(full);
      if (st.isFile() && entry.endsWith(".md") && entry !== "README.md") {
        topics.add(entry.replace(/\.md$/, ""));
      } else if (st.isDirectory()) {
        const topicFile = path.join(full, "topic.md");
        try {
          const topicStat = await stat(topicFile);
          if (topicStat.isFile()) topics.add(entry);
        } catch {
          // Not a topic folder.
        }
      }
    } catch {
      // Ignore files racing with us.
    }
  }
  return Array.from(topics).sort();
}

/**
 * @param {string} topicsDir
 * @param {string} rawName
 */
export async function createTopicRoom(topicsDir, rawName) {
  const name = normalizeTopicName(rawName);
  if (!name || !isValidTopicName(name)) {
    throw new Error("Topic name must contain letters, numbers, dashes, or underscores.");
  }

  const legacyPath = path.join(topicsDir, `${name}.md`);
  const root = path.join(topicsDir, name);
  const topicPath = path.join(root, "topic.md");
  const memoryPath = path.join(root, "memory.md");
  const decisionsPath = path.join(root, "decisions.md");
  const artifactsDir = path.join(root, "artifacts");
  const artifactsReadmePath = path.join(artifactsDir, "README.md");
  const artifactIndexPath = path.join(artifactsDir, "index.md");
  const notesDir = path.join(root, "notes");

  let created = false;
  try {
    await readFile(topicPath, "utf8");
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      await failIfLegacyTopicExists(legacyPath, name);
      await mkdir(artifactsDir, { recursive: true });
      await mkdir(notesDir, { recursive: true });
      await writeFile(topicPath, renderTopicTemplate(name), "utf8");
      created = true;
    } else {
      throw err;
    }
  }

  await mkdir(artifactsDir, { recursive: true });
  await mkdir(notesDir, { recursive: true });
  await writeFileIfMissing(memoryPath, renderMemoryTemplate(name));
  await writeFileIfMissing(decisionsPath, renderDecisionsTemplate(name));
  await writeFileIfMissing(artifactsReadmePath, renderArtifactsTemplate(name));
  await writeFileIfMissing(artifactIndexPath, renderArtifactIndexTemplate(name));

  return {
    name,
    root,
    topicPath,
    memoryPath,
    decisionsPath,
    artifactsDir,
    artifactIndexPath,
    created,
  };
}

/**
 * @param {string} legacyPath
 * @param {string} name
 */
async function failIfLegacyTopicExists(legacyPath, name) {
  try {
    const st = await stat(legacyPath);
    if (st.isFile()) {
      throw new Error(
        `Topic \`${name}\` already exists as a legacy file at ${legacyPath}. Load it with /topic ${name} or migrate it manually.`,
      );
    }
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      return;
    }
    throw err;
  }
}

/**
 * @param {string} filePath
 * @param {string} content
 */
async function writeFileIfMissing(filePath, content) {
  try {
    await readFile(filePath, "utf8");
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      await writeFile(filePath, content, "utf8");
      return;
    }
    throw err;
  }
}

/**
 * @param {string} name
 */
function renderTopicTemplate(name) {
  const title = humanizeTopicName(name);
  const today = new Date().toISOString().slice(0, 10);
  return `# Topic: ${name}

> **One-line:** ${title} project room. Fill this in with the topic's real purpose.

**Last touched:** ${today}

---

## Hat pin (always loaded)

\`\`\`yaml
pin:
  title: "${title}"
  summary: "Describe when this hat should be used and what the agent should understand immediately."
  current_state:
    - "TODO: Add current status, important paths, active owners, or environment facts."
  operating_rules:
    - "TODO: Add how the agent should behave while wearing this hat."
  settled_decisions:
    - "TODO: Add decisions already made so the agent does not re-litigate them."
  open_work:
    - "TODO: Add known next steps or unresolved questions."
  avoid:
    - "TODO: Add things not to suggest, leak, overwrite, or casually re-open."
\`\`\`

## Always load

\`\`\`yaml
files: []
\`\`\`

## Recent memory

\`\`\`yaml
recent_memory:
  filter: regex "${name}"
  last_n: 5
  prefer: entries with substantial ${name} content over passing mentions
\`\`\`

## Live state probes

\`\`\`yaml
live_probes: []
\`\`\`

## Pinned MEMORY.md sections

\`\`\`yaml
memory_md_sections: []
\`\`\`

## What is not in this topic

- Add related-but-separate subjects here.

## Manifest meta

\`\`\`yaml
schema: openclaw-topic.v1
hat_owner: user
hat_voice: agent
last_review: ${today}
\`\`\`
`;
}

/**
 * @param {string} name
 */
function renderMemoryTemplate(name) {
  return `# ${humanizeTopicName(name)} Memory

Topic-local memory for \`${name}\`.

Use this file for durable project-room context:

- completed work
- important discussion summaries
- constraints learned
- open questions
- things the user explicitly wants remembered for this topic

## Log
`;
}

/**
 * @param {string} name
 */
function renderDecisionsTemplate(name) {
  return `# ${humanizeTopicName(name)} Decisions

Durable decisions for \`${name}\`.

Use short entries with date, decision, and reason. Do not duplicate every chat.

## Decisions
`;
}

/**
 * @param {string} name
 */
function renderArtifactsTemplate(name) {
  return `# ${humanizeTopicName(name)} Artifacts

Store generated or attached topic artifacts here:

- specs
- plans
- diagrams
- reports
- exported summaries
- generated assets

Keep filenames descriptive and dated when useful.
`;
}

/**
 * @param {string} name
 */
function renderArtifactIndexTemplate(name) {
  return `# ${humanizeTopicName(name)} Artifact Index

Durable index of artifacts for \`${name}\`.

Use short dated entries. Link or name the file, say what it is, and mention why
it matters. Do not duplicate full artifact contents here.

## Artifacts
`;
}
