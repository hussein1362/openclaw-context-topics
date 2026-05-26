import { stat } from "node:fs/promises";

import { getSensitivePathReason } from "./bundler.js";
import { resolveManifestPath } from "./manifest.js";

/**
 * @typedef {import("./manifest.js").TopicManifest} TopicManifest
 */

/**
 * @param {TopicManifest} manifest
 * @returns {Promise<{ errors: string[]; warnings: string[]; info: string[] }>}
 */
export async function doctorTopic(manifest) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const info = [];

  await checkPath("manifest", manifest.sourcePath, "file", errors);

  if (manifest.format === "folder") {
    await checkPath("topic root", manifest.topicRoot, "dir", errors);
    await checkPath("memory.md", manifest.memoryPath, "file", errors);
    await checkPath("decisions.md", manifest.decisionsPath, "file", errors);
    await checkPath("artifacts/", manifest.artifactsDir, "dir", errors);
    await checkPath("artifacts/index.md", manifest.artifactIndexPath, "file", warnings);
  } else {
    warnings.push("legacy single-file topic; use a folder-backed topic room for new work");
  }

  checkPin(manifest, errors, warnings);
  await checkFiles(manifest, warnings, info);
  checkLiveProbes(manifest, warnings);
  checkReviewDate(manifest, warnings);

  return { errors, warnings, info };
}

/**
 * @param {{ errors: string[]; warnings: string[]; info: string[] }} result
 */
export function formatDoctorReport(result) {
  const total = result.errors.length + result.warnings.length + result.info.length;
  const status =
    result.errors.length > 0
      ? "FAIL"
      : result.warnings.length > 0
        ? "WARN"
        : "OK";
  const lines = [`Topic doctor: **${status}** (${total} finding${total === 1 ? "" : "s"})`];

  if (result.errors.length > 0) {
    lines.push("\nErrors:");
    for (const item of result.errors) lines.push(`- ${item}`);
  }
  if (result.warnings.length > 0) {
    lines.push("\nWarnings:");
    for (const item of result.warnings) lines.push(`- ${item}`);
  }
  if (result.info.length > 0) {
    lines.push("\nInfo:");
    for (const item of result.info) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

/**
 * @param {string} label
 * @param {string} filePath
 * @param {"file" | "dir"} kind
 * @param {string[]} out
 */
async function checkPath(label, filePath, kind, out) {
  try {
    const st = await stat(filePath);
    if (kind === "file" && !st.isFile()) out.push(`${label} exists but is not a file: ${filePath}`);
    if (kind === "dir" && !st.isDirectory()) out.push(`${label} exists but is not a directory: ${filePath}`);
  } catch (err) {
    const code = err && /** @type {NodeJS.ErrnoException} */ (err).code;
    out.push(`${label} missing or unreadable${code ? ` (${code})` : ""}: ${filePath}`);
  }
}

/**
 * @param {TopicManifest} manifest
 * @param {string[]} errors
 * @param {string[]} warnings
 */
function checkPin(manifest, errors, warnings) {
  if (!manifest.pin) {
    errors.push("missing pin block");
    return;
  }

  for (const key of ["title", "summary"]) {
    if (!isNonEmptyString(manifest.pin[key])) warnings.push(`pin.${key} is missing or empty`);
  }
  for (const key of ["current_state", "operating_rules", "settled_decisions", "open_work", "avoid"]) {
    const value = manifest.pin[key];
    if (!Array.isArray(value) || value.length === 0) {
      warnings.push(`pin.${key} should be a non-empty list`);
    } else if (value.some((item) => String(item).toLowerCase().includes("todo"))) {
      warnings.push(`pin.${key} still contains TODO text`);
    }
  }
}

/**
 * @param {TopicManifest} manifest
 * @param {string[]} warnings
 * @param {string[]} info
 */
async function checkFiles(manifest, warnings, info) {
  if (manifest.files.length === 0) {
    info.push("files list is empty; OK for small topics, but source-of-truth files improve recall");
    return;
  }

  for (const rel of manifest.files) {
    const abs = resolveManifestPath(rel);
    const sensitive = getSensitivePathReason(rel, abs);
    if (sensitive) info.push(`${rel}: ${sensitive}`);

    try {
      const st = await stat(abs);
      if (!st.isFile()) {
        warnings.push(`${rel}: exists but is not a file`);
      } else if (st.size > 20_000) {
        info.push(`${rel}: large file (${(st.size / 1024).toFixed(1)} KB), likely deferred`);
      }
    } catch (err) {
      const code = err && /** @type {NodeJS.ErrnoException} */ (err).code;
      warnings.push(`${rel}: missing or unreadable${code ? ` (${code})` : ""}`);
    }
  }
}

/**
 * @param {TopicManifest} manifest
 * @param {string[]} warnings
 */
function checkLiveProbes(manifest, warnings) {
  for (const probe of manifest.live_probes) {
    if (!probe.name.trim()) warnings.push("live probe has an empty name");
    if (looksMutating(probe.cmd)) {
      warnings.push(`live probe "${probe.name}" looks mutating; probes should be read-only`);
    }
  }
}

/**
 * @param {TopicManifest} manifest
 * @param {string[]} warnings
 */
function checkReviewDate(manifest, warnings) {
  const raw = manifest.extras?.last_review;
  if (!isNonEmptyString(raw)) {
    warnings.push("last_review is missing");
    return;
  }

  const reviewedAt = Date.parse(raw);
  if (Number.isNaN(reviewedAt)) {
    warnings.push(`last_review is not parseable: ${raw}`);
    return;
  }

  const days = (Date.now() - reviewedAt) / 86_400_000;
  if (days > 90) warnings.push(`last_review is stale (${Math.floor(days)} days old)`);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * @param {string} cmd
 */
function looksMutating(cmd) {
  return /(^|\s)(rm|mv|cp|chmod|chown|kill|pkill|openclaw\s+.*restart|curl\s+.*(-X|--request)\s*(POST|PUT|PATCH|DELETE))(\s|$)/i.test(
    cmd,
  );
}
