// Topic manifest parser.
//
// Manifests are human-readable Markdown files at `~/openclaw-soul/topics/<name>.md`.
// We don't parse the prose. We only extract YAML code blocks (```yaml ... ```)
// and merge their top-level keys into a single TopicManifest object.
//
// Supported keys (others are preserved but unused for now):
//   pin:                  small always-loaded working context object
//   files:                list of paths (strings)
//   live_probes:          list of { name, cmd }
//   memory_md_sections:   list of strings
//   recent_memory:        { filter, last_n, prefer }
//   schema, hat_owner, hat_voice, last_review, estimated_load_tokens: scalars
//
// Paths in `files:` may be:
//   - absolute (start with /)
//   - relative to ~/openclaw-soul (e.g. "projects/product-launch/brief.md")
//   - prefixed with ~/  (expanded to $HOME)

import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SOUL_ROOT = path.join(os.homedir(), "openclaw-soul");

/**
 * @typedef {Object} TopicLiveProbe
 * @property {string} name
 * @property {string} cmd
 */

/**
 * @typedef {Object} TopicManifest
 * @property {string}        name
 * @property {string}        sourcePath
 * @property {"folder" | "legacy-file"} format
 * @property {string}        topicRoot
 * @property {string}        memoryPath
 * @property {string}        decisionsPath
 * @property {string}        artifactsDir
 * @property {string}        artifactIndexPath
 * @property {Record<string, unknown> | null} pin
 * @property {string[]}      files
 * @property {TopicLiveProbe[]} live_probes
 * @property {string[]}      memory_md_sections
 * @property {Record<string, unknown>} extras
 */

/**
 * Resolve a path string from a manifest to an absolute filesystem path.
 * @param {string} p
 * @returns {string}
 */
export function resolveManifestPath(p) {
  if (!p || typeof p !== "string") return "";
  let s = p.trim();
  // strip inline comments ("# comment") AFTER the path
  s = s.replace(/\s+#.*$/, "").trim();
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
  if (path.isAbsolute(s)) return s;
  return path.join(SOUL_ROOT, s);
}

/**
 * Extract every fenced YAML code block from a markdown string.
 * Matches:  ```yaml ... ```   (case-insensitive on the language tag)
 * @param {string} md
 * @returns {string[]}
 */
function extractYamlBlocks(md) {
  /** @type {string[]} */
  const blocks = [];
  const re = /```ya?ml\s*\n([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(md)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

/**
 * Tiny YAML reader for our restricted manifest shape.
 *
 * Supports:
 *   key: scalar             -> { key: "scalar" }
 *   key:                    -> opens a block
 *     - item                -> array of strings
 *     - key: v              -> array of objects
 *       key: v
 *   key: |                  -> NOT supported (we don't need it)
 *   inline lists [a, b]     -> NOT supported (we don't use them)
 *
 * Comments (`#`) and blank lines are skipped. Quotes around values are stripped.
 *
 * @param {string} text
 * @returns {Record<string, any>}
 */
function parseSimpleYaml(text) {
  /** @type {Record<string, any>} */
  const out = {};

  // Tokenize lines with indent + content (strip inline comments + trailing whitespace)
  const lines = text
    .split(/\r?\n/)
    .map((raw) => {
      // strip inline comments only when "#" is preceded by whitespace OR at line start
      // (so URLs like http://x#y aren't broken)
      const stripped = raw.replace(/(\s|^)#.*$/, "$1").replace(/\s+$/, "");
      const indent = stripped.search(/\S|$/);
      const content = stripped.trim();
      return { indent, content, raw: stripped };
    })
    .filter((l) => l.content.length > 0);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Top-level keys must be at indent 0
    if (line.indent !== 0) {
      i++;
      continue;
    }

    const colonIdx = line.content.indexOf(":");
    if (colonIdx < 0) {
      i++;
      continue;
    }

    const key = line.content.slice(0, colonIdx).trim();
    const inlineVal = line.content.slice(colonIdx + 1).trim();

    if (inlineVal.length > 0) {
      // simple scalar
      out[key] = stripQuotes(inlineVal);
      i++;
      continue;
    }

    // Block value — collect indented lines (indent > 0)
    /** @type {{indent:number, content:string}[]} */
    const childLines = [];
    i++;
    while (i < lines.length && lines[i].indent > 0) {
      childLines.push(lines[i]);
      i++;
    }

    out[key] = parseBlock(childLines);
  }

  return out;
}

/**
 * Parse a block of child lines into either a list or a mapping.
 *
 * Detects list when the first child starts with "- ".
 * Within a list, supports either string items ("- foo") or object items
 * ("- key: value" followed by indented sibling key lines).
 *
 * Within a mapping, supports nested scalar keys at one indent level deeper.
 *
 * @param {{indent:number, content:string}[]} children
 * @returns {any}
 */
function parseBlock(children) {
  if (children.length === 0) return null;

  const baseIndent = children[0].indent;

  // List branch
  if (children[0].content.startsWith("- ") || children[0].content === "-") {
    /** @type {any[]} */
    const items = [];
    let j = 0;
    while (j < children.length) {
      const ln = children[j];
      if (ln.indent !== baseIndent || !ln.content.startsWith("-")) {
        // unexpected - skip
        j++;
        continue;
      }
      const itemHead = ln.content.replace(/^-\s*/, "");

      // Gather sub-lines that are deeper-indented than the dash line
      /** @type {{indent:number, content:string}[]} */
      const sub = [];
      j++;
      while (j < children.length && children[j].indent > baseIndent) {
        sub.push(children[j]);
        j++;
      }

      if (isObjectListItem(itemHead)) {
        // object item, possibly with siblings in `sub`
        /** @type {Record<string, any>} */
        const obj = {};
        const colonIdx = itemHead.indexOf(":");
        const k = itemHead.slice(0, colonIdx).trim();
        const v = itemHead.slice(colonIdx + 1).trim();
        if (v.length > 0) obj[k] = stripQuotes(v);
        else obj[k] = null;

        // Process sub-lines as further keys of this object
        // We need to normalize their indent before recursing.
        if (sub.length > 0) {
          const subBase = sub[0].indent;
          const subLines = sub.map((s) => ({
            indent: s.indent - subBase + 2, // make them look like mapping children
            content: s.content,
          }));
          const subObj = parseMappingLines(subLines);
          for (const [kk, vv] of Object.entries(subObj)) obj[kk] = vv;
        }

        items.push(obj);
      } else {
        // Plain string item
        items.push(stripQuotes(itemHead));
      }
    }
    return items;
  }

  // Mapping branch
  return parseMappingLines(children);
}

/**
 * Parse mapping-style lines (all at the same indent level) into an object.
 * Nested blocks are passed back through parseBlock.
 * @param {{indent:number, content:string}[]} lines
 * @returns {Record<string, any>}
 */
function parseMappingLines(lines) {
  /** @type {Record<string, any>} */
  const out = {};
  if (lines.length === 0) return out;
  const baseIndent = lines[0].indent;

  let j = 0;
  while (j < lines.length) {
    const ln = lines[j];
    if (ln.indent !== baseIndent) {
      j++;
      continue;
    }
    const colonIdx = ln.content.indexOf(":");
    if (colonIdx < 0) {
      j++;
      continue;
    }
    const k = ln.content.slice(0, colonIdx).trim();
    const v = ln.content.slice(colonIdx + 1).trim();
    j++;

    if (v.length > 0) {
      out[k] = stripQuotes(v);
      continue;
    }

    /** @type {{indent:number, content:string}[]} */
    const sub = [];
    while (j < lines.length && lines[j].indent > baseIndent) {
      sub.push(lines[j]);
      j++;
    }
    out[k] = parseBlock(sub);
  }
  return out;
}

/**
 * @param {string} v
 * @returns {string}
 */
function stripQuotes(v) {
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Treat `- key: value` as an object item, but keep quoted prose such as
 * `- "Phase 2: ..."` as a plain string.
 *
 * @param {string} itemHead
 */
function isObjectListItem(itemHead) {
  return /^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(itemHead);
}

/**
 * Load and parse a topic manifest by name.
 * Returns null if the file doesn't exist.
 *
 * @param {string} name
 * @param {string} topicsDir
 * @returns {Promise<TopicManifest | null>}
 */
export async function loadManifest(name, topicsDir) {
  const safe = name.replace(/[^a-z0-9_\-]/gi, "");
  if (!safe || safe !== name) return null;
  const folderRoot = path.join(topicsDir, safe);
  const folderSourcePath = path.join(folderRoot, "topic.md");
  const legacySourcePath = path.join(topicsDir, `${safe}.md`);

  let md;
  let sourcePath = folderSourcePath;
  let format = /** @type {"folder" | "legacy-file"} */ ("folder");
  let topicRoot = folderRoot;
  let memoryPath = path.join(folderRoot, "memory.md");
  let decisionsPath = path.join(folderRoot, "decisions.md");
  let artifactsDir = path.join(folderRoot, "artifacts");
  let artifactIndexPath = path.join(artifactsDir, "index.md");

  try {
    md = await readFile(sourcePath, "utf8");
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      sourcePath = legacySourcePath;
      format = "legacy-file";
      topicRoot = topicsDir;
      memoryPath = path.join(topicsDir, `${safe}.memory.md`);
      decisionsPath = path.join(topicsDir, `${safe}.decisions.md`);
      artifactsDir = path.join(topicsDir, `${safe}.artifacts`);
      artifactIndexPath = path.join(artifactsDir, "index.md");
      try {
        md = await readFile(sourcePath, "utf8");
      } catch (legacyErr) {
        if (
          legacyErr &&
          /** @type {NodeJS.ErrnoException} */ (legacyErr).code === "ENOENT"
        ) {
          return null;
        }
        throw legacyErr;
      }
    } else {
      throw err;
    }
  }

  const merged = /** @type {Record<string, any>} */ ({});
  for (const block of extractYamlBlocks(md)) {
    const parsed = parseSimpleYaml(block);
    for (const [k, v] of Object.entries(parsed)) {
      merged[k] = v;
    }
  }

  /** @type {string[]} */
  const files = Array.isArray(merged.files)
    ? merged.files
        .filter((s) => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim())
    : [];

  /** @type {TopicLiveProbe[]} */
  const live_probes = Array.isArray(merged.live_probes)
    ? merged.live_probes
        .filter(
          (p) =>
            p &&
            typeof p === "object" &&
            typeof p.name === "string" &&
            typeof p.cmd === "string",
        )
        .map((p) => ({ name: p.name.trim(), cmd: p.cmd }))
    : [];

  /** @type {string[]} */
  const memory_md_sections = Array.isArray(merged.memory_md_sections)
    ? merged.memory_md_sections
        .filter((s) => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim())
    : [];

  const pin =
    merged.pin && typeof merged.pin === "object" && !Array.isArray(merged.pin)
      ? /** @type {Record<string, unknown>} */ (merged.pin)
      : null;

  // Stash everything else under extras so future readers can use it without
  // re-parsing the markdown.
  const extras = { ...merged };
  delete extras.pin;
  delete extras.files;
  delete extras.live_probes;
  delete extras.memory_md_sections;

  return {
    name: safe,
    sourcePath,
    format,
    topicRoot,
    memoryPath,
    decisionsPath,
    artifactsDir,
    artifactIndexPath,
    pin,
    files,
    live_probes,
    memory_md_sections,
    extras,
  };
}
