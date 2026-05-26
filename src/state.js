// Plugin-owned Context Hat state.
//
// Keep this outside OpenClaw internals so the feature survives gateway updates.
// The state is keyed by a one-way hash of the OpenClaw sessionKey and stores
// only the active topic name plus timestamps.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

const STATE_DIR = path.join(os.homedir(), "openclaw-soul", "state");
const STATE_FILE = path.join(STATE_DIR, "context-topics.json");

/**
 * @typedef {Object} TopicSessionState
 * @property {string} topic
 * @property {number} setAt
 * @property {number} updatedAt
 * @property {number} [closeRequestedAt]
 * @property {string} [closeReason]
 * @property {string} [closeSessionFile]
 * @property {string} [switchToTopic]
 * @property {number} [refreshRequestedAt]
 * @property {string} [refreshReason]
 */

/**
 * @typedef {Object} TopicStateFile
 * @property {number} version
 * @property {Record<string, TopicSessionState>} sessions
 */

/**
 * @returns {Promise<TopicStateFile>}
 */
export async function loadTopicState() {
  let raw;
  try {
    raw = await readFile(STATE_FILE, "utf8");
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
      return emptyState();
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState();
  }

  if (!parsed || typeof parsed !== "object") return emptyState();
  const sessions =
    parsed.sessions && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)
      ? parsed.sessions
      : {};

  return {
    version: 1,
    sessions: Object.fromEntries(
      Object.entries(sessions).filter(([, value]) => isTopicSessionState(value)),
    ),
  };
}

/**
 * @param {string} sessionKey
 * @returns {Promise<TopicSessionState | undefined>}
 */
export async function getActiveTopic(sessionKey) {
  const state = await loadTopicState();
  const slot = getSessionSlot(state, sessionKey);
  if (slot.legacyKey && slot.value) {
    state.sessions[slot.key] = slot.value;
    delete state.sessions[slot.legacyKey];
    await saveTopicState(state);
  }
  return slot.value;
}

/**
 * @param {string} sessionKey
 * @param {string} topic
 * @returns {Promise<TopicSessionState>}
 */
export async function setActiveTopic(sessionKey, topic) {
  const state = await loadTopicState();
  const slot = getSessionSlot(state, sessionKey);
  const now = Date.now();
  const previous = slot.value;
  const next = {
    topic,
    setAt: previous?.topic === topic ? previous.setAt : now,
    updatedAt: now,
  };
  state.sessions[slot.key] = next;
  if (slot.legacyKey) delete state.sessions[slot.legacyKey];
  await saveTopicState(state);
  return next;
}

/**
 * @param {string} sessionKey
 * @returns {Promise<boolean>}
 */
export async function clearActiveTopic(sessionKey) {
  const state = await loadTopicState();
  const slot = getSessionSlot(state, sessionKey);
  const existed = Boolean(slot.value);
  delete state.sessions[slot.key];
  if (slot.legacyKey) delete state.sessions[slot.legacyKey];
  await saveTopicState(state);
  return existed;
}

/**
 * @param {string} sessionKey
 * @param {{ reason?: string; sessionFile?: string; switchToTopic?: string }} params
 * @returns {Promise<TopicSessionState | undefined>}
 */
export async function requestTopicClose(sessionKey, params = {}) {
  const state = await loadTopicState();
  const slot = getSessionSlot(state, sessionKey);
  const active = slot.value;
  if (!active) return undefined;
  const next = {
    ...active,
    closeRequestedAt: Date.now(),
    closeReason: params.reason,
    closeSessionFile: params.sessionFile,
    switchToTopic: params.switchToTopic,
    updatedAt: Date.now(),
  };
  state.sessions[slot.key] = next;
  if (slot.legacyKey) delete state.sessions[slot.legacyKey];
  await saveTopicState(state);
  return next;
}

/**
 * @param {string} sessionKey
 * @param {string} topic
 * @param {{ reason?: string }} params
 * @returns {Promise<TopicSessionState>}
 */
export async function requestTopicRefresh(sessionKey, topic, params = {}) {
  const state = await loadTopicState();
  const slot = getSessionSlot(state, sessionKey);
  const now = Date.now();
  const previous = slot.value;
  const next = {
    topic,
    setAt: previous?.topic === topic ? previous.setAt : now,
    updatedAt: now,
    refreshRequestedAt: now,
    refreshReason: params.reason,
  };
  state.sessions[slot.key] = next;
  if (slot.legacyKey) delete state.sessions[slot.legacyKey];
  await saveTopicState(state);
  return next;
}

/**
 * @param {TopicStateFile} state
 */
async function saveTopicState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, STATE_FILE);
}

/**
 * @returns {TopicStateFile}
 */
function emptyState() {
  return { version: 1, sessions: {} };
}

/**
 * @param {TopicStateFile} state
 * @param {string} sessionKey
 * @returns {{ key: string; value?: TopicSessionState; legacyKey?: string }}
 */
function getSessionSlot(state, sessionKey) {
  const key = sessionStorageKey(sessionKey);
  if (state.sessions[key]) return { key, value: state.sessions[key] };
  if (state.sessions[sessionKey]) {
    return { key, value: state.sessions[sessionKey], legacyKey: sessionKey };
  }
  return { key };
}

/**
 * @param {string} sessionKey
 */
function sessionStorageKey(sessionKey) {
  return `sha256:${createHash("sha256").update(sessionKey).digest("hex").slice(0, 32)}`;
}

/**
 * @param {unknown} value
 * @returns {value is TopicSessionState}
 */
function isTopicSessionState(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof /** @type {TopicSessionState} */ (value).topic === "string" &&
      typeof /** @type {TopicSessionState} */ (value).setAt === "number" &&
      typeof /** @type {TopicSessionState} */ (value).updatedAt === "number",
  );
}
