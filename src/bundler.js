// Topic context bundler.
//
// Takes a parsed TopicManifest and produces a single string suitable for
// a prompt-hook prependContext block. The bundle is composed of:
//
//   1. A header announcing the topic load.
//   2. A small manifest `pin` section that always loads first.
//   3. Each manifest `files[]` entry, read from disk with a per-file size cap.
//   4. Notes for manifest features that are NOT auto-resolved in this phase
//      (live_probes, recent_memory, memory_md_sections) — the agent can
//      pull them on demand if it needs them.
//
// File access policy:
//   - Manifests are author-trusted (you write them by hand). We don't gate paths.
//   - We DO cap per-file bytes and total bundle bytes to avoid runaway context.
//   - Sensitive-looking files are never inlined, and their absolute paths are
//     not exposed in the prompt bundle.
//   - Read errors are reported inline as "[file unreadable: ...]" instead of
//     failing the whole load.
//
// Why no live_probes here:
//   Spawning shell commands from a plugin triggers OpenClaw's install-time
//   safety scanner (it can't tell `ping reachy-mini.local` from anything more
//   dangerous). We list the probes inline so the agent knows it can run them
//   on demand via the host's exec tool if the user asks. A future refresh
//   workflow can run them out-of-band and pre-cache the output to a file the
//   bundler then reads.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveManifestPath } from "./manifest.js";

// Keep prompt injections intentionally modest. The old next-turn injection path
// hard-capped text at 32 KiB; the prompt hook path does not have that exact cap,
// but persistent hats should still leave plenty of room for the conversation.
const SDK_INJECTION_HARD_CAP = 32 * 1024;
const TOTAL_BUNDLE_MAX_BYTES = 30_000;
const PER_FILE_MAX_BYTES = 20_000;
const TOPIC_MEMORY_MAX_BYTES = 6_000;
const TOPIC_DECISIONS_MAX_BYTES = 4_000;
const TOPIC_ARTIFACT_INDEX_MAX_BYTES = 4_000;

export { SDK_INJECTION_HARD_CAP };

/**
 * @typedef {import("./manifest.js").TopicManifest} TopicManifest
 * @typedef {import("./manifest.js").TopicLiveProbe} TopicLiveProbe
 */

/**
 * Build the bundle string.
 * @param {TopicManifest} manifest
 * @param {BundleOptions} [options]
 * @returns {Promise<{ text: string; stats: BundleStats }>}
 */
export async function buildTopicBundle(manifest, options = {}) {
  const totalMaxBytes = options.totalMaxBytes ?? TOTAL_BUNDLE_MAX_BYTES;
  const perFileMaxBytes = options.perFileMaxBytes ?? PER_FILE_MAX_BYTES;
  const mode = options.mode ?? "full";

  /** @type {string[]} */
  const parts = [];
  /** @type {BundleStats} */
  const stats = {
    filesIncluded: 0,
    filesSkipped: 0,
    filesTruncated: 0,
    probesDeferred: 0,
    bytesEmitted: 0,
    truncatedAtBudget: false,
  };

  parts.push(
    `# [context-topic] ${manifest.name}\n` +
      `Source manifest: ${manifest.sourcePath}\n` +
      `Loaded at: ${new Date().toISOString()}\n` +
      `Mode: ${mode}\n` +
      `\n` +
      `The following block is a curated context bundle for the topic "${manifest.name}". ` +
      `Use this material to ground your responses about this topic. ` +
      `Treat code and file contents as authoritative source-of-truth references.\n`,
  );

  if (manifest.pin) {
    parts.push(renderPin(manifest.pin));
  }

  parts.push(await renderTopicRoom(manifest));

  // --- Files ---
  //
  // Strategy: inline files in manifest order until the total bundle bytes
  // would push past TOTAL_BUNDLE_MAX_BYTES. Anything not inlined gets listed
  // as a deferred reference with its path + size, so the agent knows where
  // to look without burning context on every byte upfront.
  /** @type {{ rel: string; bytes: number; reason: string; sensitive?: boolean }[]} */
  const deferredFiles = [];
  if (manifest.files.length > 0) {
    parts.push(`\n## Files (${manifest.files.length})\n`);

    let runningTotal = currentSize(parts);

    for (const rel of manifest.files) {
      const abs = resolveManifestPath(rel);

      // Peek file size before committing to inline it.
      let fileBytes = -1;
      try {
        const st = await import("node:fs/promises").then((m) => m.stat(abs));
        fileBytes = st.size;
      } catch {
        fileBytes = -1;
      }

      const sensitiveReason = getSensitivePathReason(rel, abs);
      if (sensitiveReason) {
        stats.filesSkipped++;
        deferredFiles.push({
          rel,
          bytes: fileBytes,
          reason: sensitiveReason,
          sensitive: true,
        });
        continue;
      }

      // Decide: inline (within budget) or defer (over budget / too big alone)
      const projectedAfter =
        runningTotal +
        (fileBytes > 0 ? Math.min(fileBytes, perFileMaxBytes) : 0) +
        rel.length +
        128; // wrapper overhead

      if (fileBytes > 0 && projectedAfter > totalMaxBytes) {
        stats.filesSkipped++;
        stats.truncatedAtBudget = true;
        deferredFiles.push({
          rel,
          bytes: fileBytes,
          reason: `over bundle budget (file is ${fileBytes}B, ${runningTotal}B already used of ${totalMaxBytes}B)`,
        });
        continue;
      }

      const block = await readFileForBundle(rel, abs, perFileMaxBytes);
      if (block.skipped) {
        stats.filesSkipped++;
        deferredFiles.push({
          rel,
          bytes: fileBytes,
          reason: "file unreadable at bundle time",
        });
      } else {
        stats.filesIncluded++;
        if (block.truncated) stats.filesTruncated++;
      }
      parts.push(block.text);
      runningTotal += block.text.length;
    }
  }

  // --- Deferred files (paths only, agent reads on demand) ---
  const blockedSensitiveFiles = deferredFiles.filter((f) => f.sensitive);
  const readableDeferredFiles = deferredFiles.filter((f) => !f.sensitive);
  if (readableDeferredFiles.length > 0) {
    parts.push(
      `\n## Files NOT inlined (${readableDeferredFiles.length}) — read on demand\n` +
        `These were named by the manifest but did not fit in the bundle budget. ` +
        `Use the \`read\` tool with their absolute path when the user asks about them:\n\n`,
    );
    for (const f of readableDeferredFiles) {
      const abs = resolveManifestPath(f.rel);
      const sizeStr =
        f.bytes > 0 ? `${(f.bytes / 1024).toFixed(1)} KB` : "unknown size";
      parts.push(`- \`${f.rel}\` (${sizeStr}) → \`${abs}\` — ${f.reason}\n`);
    }
  }

  if (blockedSensitiveFiles.length > 0) {
    parts.push(
      `\n## Sensitive files blocked (${blockedSensitiveFiles.length})\n` +
        `These manifest entries look like credentials or secrets. The topic plugin did not inline them, ` +
        `did not reveal their absolute paths, and will not ask the agent to read them on demand. ` +
        `Remove them from the topic manifest unless the user explicitly creates a safer, redacted reference.\n\n`,
    );
    for (const f of blockedSensitiveFiles) {
      const sizeStr =
        f.bytes > 0 ? `${(f.bytes / 1024).toFixed(1)} KB` : "unknown size";
      parts.push(`- [redacted sensitive path] (${sizeStr}) — ${f.reason}\n`);
    }
  }

  // --- Live probes (NOT auto-executed; listed for the agent) ---
  if (manifest.live_probes.length > 0) {
    parts.push(
      `\n## Live state probes (${manifest.live_probes.length}) — deferred\n` +
        `These commands are defined in the manifest but are NOT auto-executed by ` +
        `the topic plugin. Run them via the host's exec tool if current state is ` +
        `needed for this turn:\n\n`,
    );
    for (const probe of manifest.live_probes) {
      stats.probesDeferred++;
      parts.push(
        `### probe: ${probe.name}\n` +
          "```bash\n" +
          probe.cmd +
          (probe.cmd.endsWith("\n") ? "" : "\n") +
          "```\n\n",
      );
    }
  }

  // --- Manifest extras (not auto-loaded, just listed) ---
  const notes = [];
  if (manifest.memory_md_sections.length > 0) {
    notes.push(
      `- pinned MEMORY.md sections: ${manifest.memory_md_sections
        .map((s) => `"${s}"`)
        .join(", ")} ` +
        `(not auto-extracted in this phase; agent may search MEMORY.md by these titles)`,
    );
  }
  if (manifest.extras && manifest.extras.recent_memory) {
    const rm = /** @type {any} */ (manifest.extras.recent_memory);
    notes.push(
      `- recent_memory rule: filter=${JSON.stringify(rm.filter)} last_n=${rm.last_n} prefer=${JSON.stringify(rm.prefer)} ` +
        `(not auto-applied in this phase; use scripts/memory_retrieval.py or grep memory/ if needed)`,
    );
  }
  if (notes.length > 0) {
    parts.push(`\n## Manifest extras (not auto-loaded)\n${notes.join("\n")}\n`);
  }

  parts.push(
    `\n[end of context-topic bundle: ${manifest.name}]\n`,
  );

  const text = parts.join("");
  stats.bytesEmitted = text.length;
  return { text, stats };
}

/**
 * @param {TopicManifest} manifest
 */
async function renderTopicRoom(manifest) {
  const parts = [
    "\n## Topic room\n",
    `- Format: ${manifest.format}\n`,
    `- Topic root: \`${manifest.topicRoot}\`\n`,
    `- Topic memory: \`${manifest.memoryPath}\`\n`,
    `- Topic decisions: \`${manifest.decisionsPath}\`\n`,
    `- Topic artifacts: \`${manifest.artifactsDir}\`\n`,
    `- Artifact index: \`${manifest.artifactIndexPath}\`\n`,
  ];

  parts.push(await readTopicRoomFile("Recent topic memory", manifest.memoryPath, TOPIC_MEMORY_MAX_BYTES));
  parts.push(await readTopicRoomFile("Topic decisions", manifest.decisionsPath, TOPIC_DECISIONS_MAX_BYTES));
  parts.push(await readTopicRoomFile("Artifact index", manifest.artifactIndexPath, TOPIC_ARTIFACT_INDEX_MAX_BYTES));
  return parts.join("");
}

/**
 * @param {string} title
 * @param {string} filePath
 * @param {number} maxBytes
 */
async function readTopicRoomFile(title, filePath, maxBytes) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      return `\n### ${title}\nNo file yet. Create or update \`${filePath}\` when this topic accumulates durable context.\n`;
    }
    return `\n### ${title}\n[file unreadable: ${filePath}]\n`;
  }

  const trimmed = content.trim();
  if (!trimmed) return `\n### ${title}\n(empty)\n`;
  const truncated = trimmed.length > maxBytes;
  const body = truncated
    ? `${trimmed.slice(Math.max(0, trimmed.length - maxBytes))}\n\n[... earlier content omitted from topic room view ...]`
    : trimmed;
  return `\n### ${title}${truncated ? " (tail)" : ""}\n${body}\n`;
}

/**
 * @param {Record<string, unknown>} pin
 */
function renderPin(pin) {
  const title = asString(pin.title);
  const summary = asString(pin.summary);
  const lines = ["\n## Hat pin\n"];

  if (title) lines.push(`### ${title}\n`);
  if (summary) lines.push(`${summary}\n`);

  for (const [key, value] of Object.entries(pin)) {
    if (key === "title" || key === "summary") continue;
    const label = formatPinLabel(key);
    const rendered = renderPinValue(value);
    if (!rendered) continue;
    lines.push(`\n### ${label}\n${rendered}`);
  }

  return lines.join("");
}

/**
 * @param {unknown} value
 */
function renderPinValue(value) {
  if (typeof value === "string") return `${value}\n`;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => renderPinListItem(item))
      .filter((item) => item.length > 0);
    return items.length > 0 ? `${items.join("\n")}\n` : "";
  }
  if (value && typeof value === "object") {
    const rows = [];
    for (const [key, nestedValue] of Object.entries(value)) {
      const rendered = renderPinValue(nestedValue).trim();
      if (rendered) rows.push(`- ${formatPinLabel(key)}: ${rendered}`);
    }
    return rows.length > 0 ? `${rows.join("\n")}\n` : "";
  }
  return "";
}

/**
 * @param {unknown} item
 */
function renderPinListItem(item) {
  if (typeof item === "string") return `- ${item}`;
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const parts = [];
    for (const [key, value] of Object.entries(item)) {
      const rendered = renderPinValue(value).trim();
      if (rendered) parts.push(`${formatPinLabel(key)}: ${rendered}`);
    }
    return parts.length > 0 ? `- ${parts.join("; ")}` : "";
  }
  return "";
}

/**
 * @param {unknown} value
 */
function asString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

/**
 * @param {string} key
 */
function formatPinLabel(key) {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * @typedef {Object} BundleStats
 * @property {number}  filesIncluded
 * @property {number}  filesSkipped
 * @property {number}  filesTruncated
 * @property {number}  probesDeferred
 * @property {number}  bytesEmitted
 * @property {boolean} truncatedAtBudget
 */

/**
 * @typedef {Object} BundleOptions
 * @property {number} [totalMaxBytes]
 * @property {number} [perFileMaxBytes]
 * @property {"full" | "pin"} [mode]
 */

/**
 * @param {string[]} parts
 */
function currentSize(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  return n;
}

/**
 * @param {string} relLabel
 * @param {string} absPath
 * @param {number} perFileMaxBytes
 * @returns {Promise<{text:string, skipped:boolean, truncated:boolean}>}
 */
async function readFileForBundle(relLabel, absPath, perFileMaxBytes) {
  const ext = path.extname(absPath).toLowerCase();
  const fence = pickFence(ext);

  let content;
  try {
    content = await readFile(absPath, "utf8");
  } catch (err) {
    const code =
      err && /** @type {NodeJS.ErrnoException} */ (err).code
        ? /** @type {NodeJS.ErrnoException} */ (err).code
        : "ERR";
    return {
      text: `\n### ${relLabel}\n[file unreadable: ${code}]\n`,
      skipped: true,
      truncated: false,
    };
  }

  let truncated = false;
  const originalLength = content.length;
  if (content.length > perFileMaxBytes) {
    content =
      content.slice(0, perFileMaxBytes) +
      `\n\n[... truncated: file is ${originalLength} bytes, cap is ${perFileMaxBytes} ...]`;
    truncated = true;
  }

  // Markdown is rendered inline; everything else gets fenced.
  const isMarkdown = ext === ".md" || ext === ".markdown";

  const body = isMarkdown
    ? `${content}\n`
    : "```" + fence + "\n" + content + (content.endsWith("\n") ? "" : "\n") + "```\n";

  return {
    text: `\n### ${relLabel}${truncated ? " (truncated)" : ""}\n${body}`,
    skipped: false,
    truncated,
  };
}

/**
 * Keep files that are likely to contain credentials out of automatic prompt
 * injection and out of deferred read instructions.
 *
 * @param {string} relLabel
 * @param {string} absPath
 * @returns {string}
 */
export function getSensitivePathReason(relLabel, absPath) {
  const normalized = `${relLabel}/${absPath}`.toLowerCase();
  const base = path.basename(absPath).toLowerCase();

  const exactNames = new Set([
    ".env",
    ".npmrc",
    ".netrc",
    "secrets.md",
    "secret.md",
    "credentials.md",
    "credential.md",
    "tokens.md",
    "token.md",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
  ]);

  if (exactNames.has(base) || base.startsWith(".env.")) {
    return "sensitive filename; intentionally not inlined";
  }

  if (
    base.endsWith(".pem") ||
    base.endsWith(".p12") ||
    base.endsWith(".pfx") ||
    base.endsWith(".key")
  ) {
    return "sensitive key/certificate extension; intentionally not inlined";
  }

  if (
    /(^|[/_.-])(secrets?|credentials?|tokens?|api[-_]?keys?|private[-_]?keys?)([/_.-]|$)/.test(
      normalized,
    )
  ) {
    return "sensitive path pattern; intentionally not inlined";
  }

  return "";
}

/**
 * @param {string} ext
 * @returns {string}
 */
function pickFence(ext) {
  switch (ext) {
    case ".py":
      return "python";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".ts":
      return "typescript";
    case ".sh":
    case ".bash":
      return "bash";
    case ".json":
      return "json";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".toml":
      return "toml";
    case ".html":
      return "html";
    case ".css":
      return "css";
    default:
      return "";
  }
}
