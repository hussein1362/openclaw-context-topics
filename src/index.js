// Context Topics — /topic <name> change-hats plugin
//
// Phase 3: persistent Context Hat + topic rooms.
//   - /topic            -> usage
//   - /topic list       -> enumerate ~/openclaw-soul/topics
//   - /topic new <name> -> create a folder-backed topic room
//   - /topic capture <name> -> create a topic from the current session
//   - /topic <name>     -> parse manifest, store active hat for this session
//   - /topic status     -> show current hat
//   - /topic panel      -> show a chat-stream topic panel
//   - /topic close      -> ask the agent to close out topic memory/decisions
//   - /topic refresh    -> ask the agent to refresh topic.md from room state
//   - /topic doctor     -> deterministic topic room health check
//   - /topic clear      -> remove the active hat
//   - before_prompt_build injects the active hat context every turn.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { readFile, stat } from "node:fs/promises";

import { loadManifest } from "./manifest.js";
import { buildTopicBundle } from "./bundler.js";
import { doctorTopic, formatDoctorReport } from "./doctor.js";
import {
  clearActiveTopic,
  getActiveTopic,
  requestTopicCapture,
  requestTopicClose,
  requestTopicRefresh,
  setActiveTopic,
} from "./state.js";
import {
  createTopicRoom,
  isValidTopicName,
  listTopicNames,
  normalizeTopicName,
} from "./topic-room.js";

const TOPICS_DIR = path.join(os.homedir(), "openclaw-soul", "topics");
const PIN_TOTAL_MAX_BYTES = 12_000;
const PIN_PER_FILE_MAX_BYTES = 8_000;
const CACHE_TTL_MS = 15_000;
const COMMAND_PICKER_DESCRIPTION =
  "Context Hat project rooms. Commands: /topic list (topics); /topic new <name> (create blank); /topic capture <name> (capture current chat); /topic <name> (switch/load); /topic status (active); /topic panel [name] (chat panel); /topic close [reason] (cleanup); /topic refresh [name] (update pin); /topic doctor [name] (validate); /topic clear (off).";
const SESSION_EXTENSION_NAMESPACE = "active-topic";
const SESSION_EXTENSION_SLOT_KEY = "contextTopic";

/** @type {Map<string, { expiresAt: number; text: string; stats: import("./bundler.js").BundleStats; manifest: import("./manifest.js").TopicManifest }>} */
const bundleCache = new Map();

/**
 * @param {string} sessionKey
 */
function redactSessionKey(sessionKey) {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
}

/**
 * Format a one-line summary of bundle stats for the user-facing reply.
 * @param {import("./bundler.js").BundleStats} stats
 */
function summarizeStats(stats) {
  const bits = [];
  bits.push(`${stats.filesIncluded} file${stats.filesIncluded === 1 ? "" : "s"}`);
  if (stats.filesTruncated > 0) bits.push(`${stats.filesTruncated} truncated`);
  if (stats.filesSkipped > 0) bits.push(`${stats.filesSkipped} skipped`);
  if (stats.probesDeferred > 0) {
    bits.push(`${stats.probesDeferred} probe${stats.probesDeferred === 1 ? "" : "s"} deferred`);
  }
  const kb = (stats.bytesEmitted / 1024).toFixed(1);
  bits.push(`${kb} KB`);
  if (stats.truncatedAtBudget) bits.push("⚠️ bundle truncated at budget");
  return bits.join(" · ");
}

/**
 * Render a compact topic card that appears directly in the chat stream.
 * This is intentionally plain Markdown so it remains upstream-safe: no
 * Control UI bundle patches, no custom frontend mount points.
 *
 * @param {{
 *   manifest: import("./manifest.js").TopicManifest;
 *   active?: import("./state.js").TopicSessionState;
 *   bundleStats?: import("./bundler.js").BundleStats;
 *   heading?: string;
 *   detail?: "compact" | "full";
 *   elapsedMs?: number;
 * }} params
 */
async function renderTopicCard(params) {
  const { manifest, active, bundleStats, elapsedMs } = params;
  const detail = params.detail ?? "compact";
  const pin = manifest.pin ?? {};
  const title = asNonEmptyString(pin.title) || manifest.name;
  const summary = asNonEmptyString(pin.summary);
  const lifecycle = describeLifecycle(manifest.name, active);
  const roomFacts = await readRoomFacts(manifest);

  const lines = [
    `**Context Hat: ${title}**`,
    "",
    `Topic: \`${manifest.name}\``,
    `State: ${lifecycle}`,
    `Room: \`${manifest.topicRoot}\``,
  ];

  if (summary) lines.push(`Summary: ${summary}`);
  if (bundleStats) {
    lines.push(`Bundle: ${summarizeStats(bundleStats)}${typeof elapsedMs === "number" ? `, built in ${elapsedMs}ms` : ""}`);
  }

  lines.push(
    "",
    `Memory: ${roomFacts.memory}`,
    `Decisions: ${roomFacts.decisions}`,
    `Artifacts: ${roomFacts.artifacts}`,
  );

  if (detail === "full") {
    lines.push(
      "",
      "**Pinned Shape**",
      `Files: ${manifest.files.length}`,
      `Live probes: ${manifest.live_probes.length}`,
      `Memory sections: ${manifest.memory_md_sections.length}`,
    );

    const openWork = renderPinListPreview(pin.open_work);
    const decisions = renderPinListPreview(pin.settled_decisions);
    const avoid = renderPinListPreview(pin.avoid);
    if (openWork.length > 0) lines.push("", "**Open Work**", ...openWork);
    if (decisions.length > 0) lines.push("", "**Settled Decisions**", ...decisions);
    if (avoid.length > 0) lines.push("", "**Avoid**", ...avoid);
  }

  lines.push(
    "",
    "Commands: `/topic status`, `/topic panel`, `/topic refresh`, `/topic doctor`, `/topic close`, `/topic clear`",
  );

  return lines.join("\n");
}

/**
 * @param {string} topic
 * @param {import("./state.js").TopicSessionState | undefined} active
 */
function describeLifecycle(topic, active) {
  if (!active?.topic) return "available, not active";
  if (active.topic !== topic) return `available, active hat is \`${active.topic}\``;
  if (active.closeRequestedAt && active.switchToTopic) {
    return `closing, then switching to \`${active.switchToTopic}\``;
  }
  if (active.closeRequestedAt) return "closing on the next agent turn";
  if (active.captureRequestedAt) return "capture queued for the next agent turn";
  if (active.refreshRequestedAt) return "refresh queued for the next agent turn";
  return "active in this session";
}

/**
 * @param {import("./manifest.js").TopicManifest} manifest
 */
async function readRoomFacts(manifest) {
  const [memory, decisions, artifacts] = await Promise.all([
    describeMarkdownFile(manifest.memoryPath),
    describeMarkdownFile(manifest.decisionsPath),
    describeMarkdownFile(manifest.artifactIndexPath),
  ]);
  return { memory, decisions, artifacts };
}

/**
 * @param {string} filePath
 */
async function describeMarkdownFile(filePath) {
  let content = "";
  let fileStat;
  try {
    [content, fileStat] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return "missing";
    return "unreadable";
  }

  const meaningfulLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => isMeaningfulTopicLine(line));
  const kb = (fileStat.size / 1024).toFixed(1);
  const changed = fileStat.mtime.toISOString().slice(0, 10);
  return `${meaningfulLines.length} line${meaningfulLines.length === 1 ? "" : "s"}, ${kb} KB, changed ${changed}`;
}

/**
 * @param {string} line
 */
function isMeaningfulTopicLine(line) {
  if (!line) return false;
  if (line.startsWith("#")) return false;
  if (line === "---") return false;
  if (line.startsWith("Topic-local memory for")) return false;
  if (line.startsWith("Durable decisions for")) return false;
  if (line.startsWith("Durable index of artifacts for")) return false;
  if (line.startsWith("Use this file for")) return false;
  if (line.startsWith("Use short")) return false;
  if (line.startsWith("it matters.")) return false;
  return true;
}

/**
 * @param {unknown} value
 */
function asNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * @param {unknown} value
 */
function renderPinListPreview(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .slice(0, 5)
    .map((item) => `- ${item.trim()}`);
}

/**
 * Register a typed, upstream-owned place for Control UI/session readers to
 * discover the active Context Hat. This only declares the slot; values are
 * persisted through the official `sessions.pluginPatch` gateway method.
 *
 * @param {import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginApi} api
 */
function registerTopicSessionExtension(api) {
  const register =
    api.session?.state?.registerSessionExtension ?? api.registerSessionExtension;
  if (typeof register !== "function") {
    api.logger?.warn?.(
      "context-topics: session extension API unavailable; topic UI probe disabled",
    );
    return;
  }

  register({
    namespace: SESSION_EXTENSION_NAMESPACE,
    description: "Active Context Hat metadata for this OpenClaw session.",
    sessionEntrySlotKey: SESSION_EXTENSION_SLOT_KEY,
    sessionEntrySlotSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        topic: { type: "string" },
        title: { type: "string" },
        status: { type: "string" },
        updatedAt: { type: "number" },
        source: { type: "string" },
      },
      required: ["topic", "status", "updatedAt", "source"],
    },
    project: ({ state }) => {
      if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
      const raw = /** @type {{ topic?: unknown; title?: unknown; status?: unknown; updatedAt?: unknown }} */ (state);
      if (typeof raw.topic !== "string" || !raw.topic.trim()) return undefined;
      return {
        topic: raw.topic.trim(),
        ...(typeof raw.title === "string" && raw.title.trim()
          ? { title: raw.title.trim() }
          : {}),
        status:
          typeof raw.status === "string" && raw.status.trim()
            ? raw.status.trim()
            : "active",
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
        source: "context-topics",
      };
    },
  });
}

/**
 * @param {string} topic
 * @param {string} topicsDir
 */
async function buildPinnedTopicContext(topic, topicsDir) {
  const cached = bundleCache.get(topic);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const manifest = await loadManifest(topic, topicsDir);
  if (!manifest) return null;

  const bundle = await buildTopicBundle(manifest, {
    mode: "pin",
    totalMaxBytes: PIN_TOTAL_MAX_BYTES,
    perFileMaxBytes: PIN_PER_FILE_MAX_BYTES,
  });

  const record = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    text: bundle.text,
    stats: bundle.stats,
    manifest,
  };
  bundleCache.set(topic, record);
  return record;
}

/**
 * @param {import("./manifest.js").TopicManifest} manifest
 * @param {import("./state.js").TopicSessionState} active
 */
function renderCloseoutInstructions(manifest, active) {
  const reason = active.closeReason || "manual close";
  const sessionFile = active.closeSessionFile || "(not provided by host)";
  return (
    `# Context Hat Closeout Request: ${manifest.name}\n` +
    `The user invoked /topic close. You are still wearing this hat for one final cleanup turn.\n\n` +
    `Close reason: ${reason}\n` +
    `Session file, if available: ${sessionFile}\n\n` +
    `Update the topic room with durable context from this chat:\n` +
    `- Topic memory: \`${manifest.memoryPath}\`\n` +
    `- Topic decisions: \`${manifest.decisionsPath}\`\n` +
    `- Topic artifacts: \`${manifest.artifactsDir}\`\n\n` +
    `- Artifact index: \`${manifest.artifactIndexPath}\`\n\n` +
    `Closeout rules:\n` +
    `1. Append a concise session summary to topic memory when there is anything worth keeping.\n` +
    `2. Append decisions only when actual decisions were made; include date, decision, and reason.\n` +
    `3. Create or update the artifact index with artifacts that were created, changed, or referenced.\n` +
    `4. Keep global MEMORY.md for cross-topic durable truths only.\n` +
    `5. Do not copy secrets, credentials, tokens, or irrelevant personal data into topic files.\n` +
    `6. After writing files, briefly tell the user what you updated.\n` +
    `7. This is the final turn for this hat. Do not tell the user to run /topic clear after closeout; the plugin clears the hat automatically for following turns.\n` +
    (active.switchToTopic
      ? `8. After this cleanup turn, the plugin will activate topic "${active.switchToTopic}" for the next turn. Do not start work in that next topic yet.\n`
      : "") +
    `\n`
  );
}

/**
 * @param {string} topic
 * @param {import("./state.js").TopicSessionState} active
 */
function renderContextHatPrelude(topic, active) {
  if (active.closeRequestedAt) {
    if (active.switchToTopic) {
      return (
        `# Closing Context Hat: ${topic}\n` +
        `This is a one-time closeout turn. The plugin is closing "${topic}" and will switch to "${active.switchToTopic}" for the following turn. ` +
        `Do not tell the user to run /topic clear.\n\n`
      );
    }
    return (
      `# Closing Context Hat: ${topic}\n` +
      `This is a one-time closeout turn. The plugin has removed "${topic}" from active session state for following turns. ` +
      `Do not tell the user to run /topic clear.\n\n`
    );
  }

  return (
    `# Active Context Hat: ${topic}\n` +
    `This session has an active Context Hat. Use the following curated bundle as working context. ` +
    `The user can switch hats with /topic <name>, close this with /topic close, or clear this with /topic clear.\n\n`
  );
}

/**
 * @param {import("./manifest.js").TopicManifest} manifest
 * @param {import("./state.js").TopicSessionState} active
 */
function renderRefreshInstructions(manifest, active) {
  const reason = active.refreshReason || "manual refresh";
  return (
    `# Context Hat Refresh Request: ${manifest.name}\n` +
    `The user invoked /topic refresh. Refresh the topic room's working pin and metadata.\n\n` +
    `Refresh reason: ${reason}\n\n` +
    `Read and reconcile these files:\n` +
    `- Manifest/pin: \`${manifest.sourcePath}\`\n` +
    `- Topic memory: \`${manifest.memoryPath}\`\n` +
    `- Topic decisions: \`${manifest.decisionsPath}\`\n` +
    `- Artifact index: \`${manifest.artifactIndexPath}\`\n\n` +
    `Refresh rules:\n` +
    `1. Update \`topic.md\` so the pin reflects current state, settled decisions, open work, and avoid rules.\n` +
    `2. Remove stale TODOs when the room has enough information to replace them.\n` +
    `3. Preserve \`files:\`, \`recent_memory:\`, \`live_probes:\`, and \`memory_md_sections:\` unless there is a clear reason to change them.\n` +
    `4. Update \`last_review\` to today's date.\n` +
    `5. Do not embed secrets, credentials, tokens, or secret file locations. Remove or redact them if found.\n` +
    `6. Briefly tell the user what changed.\n\n`
  );
}

/**
 * @param {import("./manifest.js").TopicManifest} manifest
 * @param {import("./state.js").TopicSessionState} active
 */
function renderCaptureInstructions(manifest, active) {
  const reason = active.captureReason || "retroactive topic capture";
  const sessionFile = active.captureSessionFile || "(not provided by host)";
  return (
    `# Context Hat Capture Request: ${manifest.name}\n` +
    `The user invoked /topic capture. They had been working without a topic and now want this current conversation to become a durable topic room.\n\n` +
    `Capture reason: ${reason}\n` +
    `Session file, if available: ${sessionFile}\n\n` +
    `Create a clean first pass of topic memory from the current conversation:\n` +
    `- Manifest/pin: \`${manifest.sourcePath}\`\n` +
    `- Topic memory: \`${manifest.memoryPath}\`\n` +
    `- Topic decisions: \`${manifest.decisionsPath}\`\n` +
    `- Topic artifacts: \`${manifest.artifactsDir}\`\n` +
    `- Artifact index: \`${manifest.artifactIndexPath}\`\n\n` +
    `Capture rules:\n` +
    `1. Read the current conversation context you can see. If the host provides a session file, read it only when needed for accurate capture.\n` +
    `2. Replace starter TODOs in \`topic.md\` with a useful pin: summary, current_state, operating_rules, settled_decisions, open_work, and avoid.\n` +
    `3. Append a concise initial session summary to \`memory.md\` with the date and why this topic exists.\n` +
    `4. Append durable decisions to \`decisions.md\` only when actual decisions were made.\n` +
    `5. Update \`artifacts/index.md\` for files, docs, links, or generated artifacts that matter to this topic.\n` +
    `6. Do not embed secrets, credentials, tokens, or secret file locations. Remove or redact them if found.\n` +
    `7. Keep global MEMORY.md for cross-topic durable truths only.\n` +
    `8. After writing files, briefly tell the user what you captured and what remains open.\n\n`
  );
}

export default definePluginEntry({
  id: "context-topics",
  name: "Context Topics",
  description:
    "Context Hat project rooms: list, new, capture, load/switch, status, panel, close, refresh, doctor, clear.",
  register(api) {
    registerTopicSessionExtension(api);

    api.registerCommand({
      name: "topic",
      // Surface the command on native command menus (Telegram, Discord,
      // Control UI "/" picker, etc.) using the same name.
      nativeNames: { default: "topic" },
      description: COMMAND_PICKER_DESCRIPTION,
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = (ctx.args || "").trim();
        const sub = args.split(/\s+/)[0] || "";

        // /topic               -> usage
        // /topic list          -> enumerate manifests
        // /topic <name>        -> load
        if (!sub || sub === "help") {
          return {
            text:
              "**Context Hat Commands**\n\n" +
              "- `/topic list` — show available topic rooms and legacy topics.\n" +
              "- `/topic new <name>` — create a folder-backed topic room and put that hat on. Alias: `/topic create <name>`.\n" +
              "- `/topic capture <name>` — create a topic room from the current no-hat conversation and ask the agent to fill memory, decisions, artifacts, and the initial pin.\n" +
              "- `/topic <name>` — put an existing hat on. If another hat is active, close it first and switch after cleanup.\n" +
              "- `/topic status` — show the active hat. Alias: `/topic current`.\n" +
              "- `/topic panel [name]` — show a chat-stream topic panel with room, memory, decisions, artifacts, and pin shape.\n" +
              "- `/topic close [reason]` — close the active topic and ask the agent to update memory, decisions, and artifact index. Alias: `/topic done`.\n" +
              "- `/topic refresh [name]` — ask the agent to refresh `topic.md` from topic memory, decisions, and artifacts.\n" +
              "- `/topic doctor [name]` — validate topic structure, pin quality, files, probes, and review date. Alias: `/topic check [name]`.\n" +
              "- `/topic clear` — take the current hat off without cleanup. Alias: `/topic off`.\n\n" +
              "Examples:\n" +
              "- `/topic new product-launch`\n" +
              "- `/topic capture surprise-project`\n" +
              "- `/topic product-launch`\n" +
              "- `/topic panel product-launch`\n" +
              "- `/topic close switching to NSN work`\n" +
              "- `/topic doctor product-launch`\n\n" +
              `Topics live in \`${TOPICS_DIR}\`. New topics use \`<name>/topic.md\` plus memory, decisions, notes, and artifacts.`,
          };
        }

        if (sub === "list") {
          const topics = await listTopicNames(TOPICS_DIR);
          if (topics.length === 0) {
            return {
              text:
                `No topics found in \`${TOPICS_DIR}\`.\n` +
                "Create one with `/topic new <name>`.",
            };
          }
          return {
            text:
              `**Available topics** (${topics.length}):\n` +
              topics.map((t) => `- \`${t}\``).join("\n") +
              "\n\nLoad one with `/topic <name>`.",
          };
        }

        if (sub === "new" || sub === "create") {
          const rawName = args.slice(sub.length).trim();
          const name = normalizeTopicName(rawName);
          if (!rawName || !name || !isValidTopicName(name)) {
            return {
              text:
                "Give the new topic a short name: `/topic new newproject`. " +
                "Use letters, numbers, dashes, or underscores.",
            };
          }
          if (!ctx.sessionKey) {
            return {
              text:
                "Can't create and activate a topic right now — this command needs an active session, and the host didn't provide a sessionKey.",
            };
          }

          let room;
          try {
            room = await createTopicRoom(TOPICS_DIR, rawName);
          } catch (err) {
            api.logger?.error?.(
              `context-topics: failed to create topic room raw=${rawName}: ${(err && err.message) || err}`,
            );
            return {
              text: `Failed to create topic room \`${name || rawName}\`: ${(err && err.message) || err}`,
            };
          }

          const manifest = await loadManifest(room.name, TOPICS_DIR);
          if (!manifest) {
            return {
              text:
                `Topic room \`${room.name}\` was created, but I couldn't load its manifest at \`${room.topicPath}\`.`,
            };
          }

          const bundle = await buildTopicBundle(manifest, {
            mode: "pin",
            totalMaxBytes: PIN_TOTAL_MAX_BYTES,
            perFileMaxBytes: PIN_PER_FILE_MAX_BYTES,
          });
          bundleCache.set(room.name, {
            expiresAt: Date.now() + CACHE_TTL_MS,
            text: bundle.text,
            stats: bundle.stats,
            manifest,
          });

          const active = await getActiveTopic(ctx.sessionKey);
          if (active?.topic && active.topic !== room.name && !active.closeRequestedAt) {
            await requestTopicClose(ctx.sessionKey, {
              reason: `switching to ${room.name}`,
              sessionFile: /** @type {any} */ (ctx).sessionFile,
              switchToTopic: room.name,
            });
            return {
              text:
                `Created topic room **${room.name}**. Current hat **${active.topic}** will close first; **${room.name}** activates after the closeout turn.`,
              continueAgent: true,
            };
          }

          await setActiveTopic(ctx.sessionKey, room.name);

          return {
            text:
              `${room.created ? "Created" : "Opened"} topic room and put that hat on.\n\n` +
              (await renderTopicCard({
                manifest,
                active: await getActiveTopic(ctx.sessionKey),
                bundleStats: bundle.stats,
                detail: "full",
              })),
          };
        }

        if (sub === "capture") {
          const rawName = args.slice(sub.length).trim();
          const name = normalizeTopicName(rawName);
          if (!rawName || !name || !isValidTopicName(name)) {
            return {
              text:
                "Give the captured topic a short name: `/topic capture newproject`. " +
                "Use letters, numbers, dashes, or underscores.",
            };
          }
          if (!ctx.sessionKey) {
            return {
              text:
                "Can't capture this conversation right now — this command needs an active session, and the host didn't provide a sessionKey.",
            };
          }

          const active = await getActiveTopic(ctx.sessionKey);
          if (active?.topic && active.topic !== name && !active.closeRequestedAt) {
            return {
              text:
                `A Context Hat is already active: **${active.topic}**.\n\n` +
                "Use `/topic close` to clean up that topic first, or `/topic clear` if you want to remove it without cleanup. Then run `/topic capture <name>`.",
            };
          }

          let room;
          try {
            room = await createTopicRoom(TOPICS_DIR, rawName);
          } catch (err) {
            api.logger?.error?.(
              `context-topics: failed to capture topic room raw=${rawName}: ${(err && err.message) || err}`,
            );
            return {
              text: `Failed to create captured topic room \`${name || rawName}\`: ${(err && err.message) || err}`,
            };
          }

          const manifest = await loadManifest(room.name, TOPICS_DIR);
          if (!manifest) {
            return {
              text:
                `Topic room \`${room.name}\` was created, but I couldn't load its manifest at \`${room.topicPath}\`.`,
            };
          }

          const bundle = await buildTopicBundle(manifest, {
            mode: "pin",
            totalMaxBytes: PIN_TOTAL_MAX_BYTES,
            perFileMaxBytes: PIN_PER_FILE_MAX_BYTES,
          });
          bundleCache.set(room.name, {
            expiresAt: Date.now() + CACHE_TTL_MS,
            text: bundle.text,
            stats: bundle.stats,
            manifest,
          });

          const next = await requestTopicCapture(ctx.sessionKey, room.name, {
            reason: `capturing current session into ${room.name}`,
            sessionFile: /** @type {any} */ (ctx).sessionFile,
          });

          return {
            text:
              `${room.created ? "Created" : "Opened"} topic room **${room.name}** and queued a retroactive capture.\n\n` +
              (await renderTopicCard({
                manifest,
                active: next,
                bundleStats: bundle.stats,
                detail: "full",
              })),
            continueAgent: true,
          };
        }

        if (sub === "status" || sub === "current") {
          if (!ctx.sessionKey) {
            return {
              text:
                "Can't check the active topic right now — the host didn't provide a sessionKey.",
            };
          }
          const active = await getActiveTopic(ctx.sessionKey);
          if (active?.topic) {
            const manifest = await loadManifest(active.topic, TOPICS_DIR);
            if (manifest) {
              const bundle = await buildPinnedTopicContext(active.topic, TOPICS_DIR);
              return {
                text: await renderTopicCard({
                  manifest,
                  active,
                  bundleStats: bundle?.stats,
                  detail: "compact",
                }),
              };
            }
          }
          return {
            text: active
              ? `Current hat: **${active.topic}**. Clear it with \`/topic clear\`.`
              : "No Context Hat is active in this session.",
          };
        }

        if (sub === "panel") {
          if (!ctx.sessionKey) {
            return {
              text:
                "Can't show the topic panel right now — the host didn't provide a sessionKey.",
            };
          }
          const requested = args.slice(sub.length).trim();
          const active = await getActiveTopic(ctx.sessionKey);
          const topic = requested || active?.topic || "";
          if (!topic) {
            return {
              text: "No topic given and no Context Hat is active. Use `/topic panel <name>` or load a topic first.",
            };
          }
          if (!/^[a-z0-9_\-]+$/i.test(topic)) {
            return {
              text: `Topic name \`${topic}\` is not valid (letters, digits, dashes and underscores only).`,
            };
          }
          const manifest = await loadManifest(topic, TOPICS_DIR);
          if (!manifest) {
            return {
              text: `No topic named \`${topic}\`. Try \`/topic list\` to see available hats.`,
            };
          }
          const bundle = await buildPinnedTopicContext(topic, TOPICS_DIR);
          return {
            text: await renderTopicCard({
              manifest,
              active,
              bundleStats: bundle?.stats,
              detail: "full",
            }),
          };
        }

        if (sub === "clear" || sub === "off") {
          if (!ctx.sessionKey) {
            return {
              text:
                "Can't clear the active topic right now — the host didn't provide a sessionKey.",
            };
          }
          const existed = await clearActiveTopic(ctx.sessionKey);
          return {
            text: existed
              ? "Context Hat cleared. Back to regular context."
              : "No Context Hat was active in this session.",
          };
        }

        if (sub === "close" || sub === "done") {
          if (!ctx.sessionKey) {
            return {
              text:
                "Can't close the active topic right now — the host didn't provide a sessionKey.",
            };
          }
          const active = await getActiveTopic(ctx.sessionKey);
          if (!active?.topic) {
            return {
              text: "No Context Hat is active in this session, so there is no topic to close.",
            };
          }
          const reason = args.slice(sub.length).trim() || "manual close";
          const next = await requestTopicClose(ctx.sessionKey, {
            reason,
            sessionFile: /** @type {any} */ (ctx).sessionFile,
          });
          if (!next) {
            return {
              text: "No Context Hat is active in this session, so there is no topic to close.",
            };
          }
          const manifest = await loadManifest(active.topic, TOPICS_DIR);
          return {
            text:
              `Closing topic. I will update its topic memory, decisions, and artifacts now.\n\n` +
              (manifest
                ? await renderTopicCard({ manifest, active: next, detail: "compact" })
                : `Context Hat: **${active.topic}**`),
            continueAgent: true,
          };
        }

        if (sub === "refresh") {
          if (!ctx.sessionKey) {
            return {
              text:
                "Can't refresh a topic right now — this command needs an active session, and the host didn't provide a sessionKey.",
            };
          }
          const requested = args.slice(sub.length).trim();
          const active = await getActiveTopic(ctx.sessionKey);
          const topic = requested || active?.topic || "";
          if (!topic) {
            return {
              text: "No topic given and no Context Hat is active. Use `/topic refresh <name>` or load a topic first.",
            };
          }
          if (!/^[a-z0-9_\-]+$/i.test(topic)) {
            return {
              text: `Topic name \`${topic}\` is not valid (letters, digits, dashes and underscores only).`,
            };
          }
          const manifest = await loadManifest(topic, TOPICS_DIR);
          if (!manifest) {
            return {
              text: `No topic named \`${topic}\`. Try \`/topic list\` to see available hats.`,
            };
          }
          const next = await requestTopicRefresh(ctx.sessionKey, topic, {
            reason: requested ? `manual refresh of ${topic}` : "manual refresh",
          });
          bundleCache.delete(topic);
          return {
            text:
              `Refreshing topic. I will update its pin from memory, decisions, and artifacts now.\n\n` +
              (await renderTopicCard({ manifest, active: next, detail: "compact" })),
            continueAgent: true,
          };
        }

        if (sub === "doctor" || sub === "check") {
          const requested = args.slice(sub.length).trim();
          const active = ctx.sessionKey ? await getActiveTopic(ctx.sessionKey) : undefined;
          const topic = requested || active?.topic || "";
          if (!topic) {
            return {
              text: "No topic given and no Context Hat is active. Use `/topic doctor <name>` or load a topic first.",
            };
          }
          if (!/^[a-z0-9_\-]+$/i.test(topic)) {
            return {
              text: `Topic name \`${topic}\` is not valid (letters, digits, dashes and underscores only).`,
            };
          }
          const manifest = await loadManifest(topic, TOPICS_DIR);
          if (!manifest) {
            return {
              text: `No topic named \`${topic}\`. Try \`/topic list\` to see available hats.`,
            };
          }
          const report = await doctorTopic(manifest);
          return {
            text: `**${topic}**\n${formatDoctorReport(report)}`,
          };
        }

        // Treat anything else as a topic name to load.
        // Validate name early so the parser doesn't have to.
        if (!/^[a-z0-9_\-]+$/i.test(sub)) {
          return {
            text:
              `Topic name \`${sub}\` is not valid (letters, digits, dashes and underscores only).`,
          };
        }

        if (!ctx.sessionKey) {
          return {
            text:
              "Can't load a topic right now — this command needs an active session, and the host didn't provide a sessionKey.",
          };
        }

        let manifest;
        try {
          manifest = await loadManifest(sub, TOPICS_DIR);
        } catch (err) {
          api.logger?.warn?.(
            `context-topics: failed to load manifest ${sub}: ${(err && err.message) || err}`,
          );
          return {
            text: `Failed to load topic manifest \`${sub}\`: ${(err && err.message) || err}`,
          };
        }
        if (!manifest) {
          return {
            text:
              `No topic named \`${sub}\`. Try \`/topic list\` to see available hats.`,
          };
        }

        // Build once now so the user gets fast feedback and bad manifests fail
        // at command time. The prompt hook rebuilds/caches the pin on turns.
        const t0 = Date.now();
        let bundle;
        try {
          bundle = await buildTopicBundle(manifest, {
            mode: "pin",
            totalMaxBytes: PIN_TOTAL_MAX_BYTES,
            perFileMaxBytes: PIN_PER_FILE_MAX_BYTES,
          });
        } catch (err) {
          api.logger?.error?.(
            `context-topics: bundle build failed for ${sub}: ${(err && err.message) || err}`,
          );
          return {
            text: `Topic \`${sub}\` found, but bundling failed: ${(err && err.message) || err}`,
          };
        }
        const elapsed = Date.now() - t0;
        bundleCache.set(sub, {
          expiresAt: Date.now() + CACHE_TTL_MS,
          text: bundle.text,
          stats: bundle.stats,
          manifest,
        });

        const active = await getActiveTopic(ctx.sessionKey);
        if (active?.topic && active.topic !== sub && !active.closeRequestedAt) {
          try {
            await requestTopicClose(ctx.sessionKey, {
              reason: `switching to ${sub}`,
              sessionFile: /** @type {any} */ (ctx).sessionFile,
              switchToTopic: sub,
            });
          } catch (err) {
            api.logger?.error?.(
              `context-topics: failed to persist switch closeout: ${(err && err.message) || err}`,
            );
            return {
              text:
                `Topic \`${sub}\` built (${summarizeStats(bundle.stats)}) but couldn't queue the switch closeout: ` +
                `${(err && err.message) || err}`,
            };
          }
          return {
            text:
              `Switching hats: **${active.topic}** will close first, then **${sub}** will be active for the next turn.`,
            continueAgent: true,
          };
        }

        try {
          await setActiveTopic(ctx.sessionKey, sub);
        } catch (err) {
          api.logger?.error?.(
            `context-topics: failed to persist topic state: ${(err && err.message) || err}`,
          );
          return {
            text:
              `Topic \`${sub}\` built (${summarizeStats(bundle.stats)}) but couldn't be pinned for this session: ` +
              `${(err && err.message) || err}`,
          };
        }

        api.logger?.info?.(
          `context-topics: pinned topic=${sub} session=${redactSessionKey(ctx.sessionKey)} bytes=${bundle.stats.bytesEmitted} files=${bundle.stats.filesIncluded} probes_deferred=${bundle.stats.probesDeferred} elapsed=${elapsed}ms`,
        );

        return {
          text:
            "Hat on.\n\n" +
            (await renderTopicCard({
              manifest,
              active: await getActiveTopic(ctx.sessionKey),
              bundleStats: bundle.stats,
              elapsedMs: elapsed,
              detail: "full",
            })),
        };
      },
    });

    api.on("before_prompt_build", async (_event, ctx) => {
      if (!ctx.sessionKey) return;

      const active = await getActiveTopic(ctx.sessionKey);
      if (!active?.topic) return;

      try {
        const bundle = await buildPinnedTopicContext(active.topic, TOPICS_DIR);
        if (!bundle) {
          api.logger?.warn?.(
            `context-topics: active topic missing manifest topic=${active.topic} session=${redactSessionKey(ctx.sessionKey)}`,
          );
          return;
        }

        const closeout = active.closeRequestedAt && bundle.manifest
          ? renderCloseoutInstructions(bundle.manifest, active)
          : "";
        const capture = !closeout && active.captureRequestedAt && bundle.manifest
          ? renderCaptureInstructions(bundle.manifest, active)
          : "";
        const refresh = !closeout && !capture && active.refreshRequestedAt && bundle.manifest
          ? renderRefreshInstructions(bundle.manifest, active)
          : "";

        if (closeout) {
          if (active.switchToTopic) {
            await setActiveTopic(ctx.sessionKey, active.switchToTopic);
          } else {
            await clearActiveTopic(ctx.sessionKey);
          }
        } else if (capture) {
          await setActiveTopic(ctx.sessionKey, active.topic);
        } else if (refresh) {
          await setActiveTopic(ctx.sessionKey, active.topic);
        }

        return {
          prependContext:
            renderContextHatPrelude(active.topic, active) +
            closeout +
            capture +
            refresh +
            bundle.text,
        };
      } catch (err) {
        api.logger?.error?.(
          `context-topics: before_prompt_build failed topic=${active.topic}: ${(err && err.message) || err}`,
        );
      }
    });

    api.logger?.info?.("context-topics plugin registered (/topic + before_prompt_build)");
  },
});
