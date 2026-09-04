#!/usr/bin/env node
/**
 * shopify-theme-mcp
 *
 * Local stdio MCP server for Claude Desktop that lets Claude read and edit a
 * Shopify theme safely:
 *
 *   - Wraps the Shopify CLI for pull / push / list / publish
 *   - Edits files in a local theme directory (git repo)
 *   - Auto-commits every mutation so you always have history + rollback
 *   - Refuses to push to the LIVE theme unless allow_live=true is passed
 *
 * Configuration (env vars, set in claude_desktop_config.json):
 *   SHOPIFY_STORE             store handle, e.g. "my-store" (from my-store.myshopify.com)
 *   THEME_DIR                 absolute path to local theme directory (required)
 *   SHOPIFY_CLI_THEME_TOKEN   Theme Access app password (optional but recommended
 *                             so the CLI never needs interactive browser auth)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STORE = process.env.SHOPIFY_STORE;
const THEME_DIR = process.env.THEME_DIR;

if (!STORE || !THEME_DIR) {
  console.error(
    "Missing required env vars. Set SHOPIFY_STORE and THEME_DIR in your claude_desktop_config.json."
  );
  process.exit(1);
}

const THEME_ROOT = path.resolve(THEME_DIR);

// Valid top-level Shopify theme directories — used to keep writes sane.
const THEME_SUBDIRS = new Set([
  "assets",
  "blocks",
  "config",
  "layout",
  "locales",
  "sections",
  "snippets",
  "templates",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class ToolError extends Error {}

/** Resolve a theme-relative path and refuse anything escaping THEME_ROOT. */
function safePath(rel: string): string {
  const cleaned = rel.replace(/^[/\\]+/, "");
  const abs = path.resolve(THEME_ROOT, cleaned);
  if (abs !== THEME_ROOT && !abs.startsWith(THEME_ROOT + path.sep)) {
    throw new ToolError(`Path escapes theme directory: ${rel}`);
  }
  return abs;
}

function warnIfUnusualDir(rel: string): string {
  const top = rel.replace(/^[/\\]+/, "").split(/[/\\]/)[0];
  if (top && !THEME_SUBDIRS.has(top)) {
    return `\n⚠️ Note: "${top}/" is not a standard Shopify theme directory (${[
      ...THEME_SUBDIRS,
    ].join(", ")}). The file was written locally but \`shopify theme push\` may ignore it.`;
  }
  return "";
}

async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd ?? THEME_ROOT,
      timeout: opts.timeoutMs ?? 300_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, SHOPIFY_CLI_NO_ANALYTICS: "1" },
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err: any) {
    const detail = [err?.stdout, err?.stderr, err?.message]
      .filter(Boolean)
      .join("\n")
      .slice(0, 8000);
    throw new ToolError(`Command failed: ${cmd} ${args.join(" ")}\n${detail}`);
  }
}

const shopify = (args: string[], timeoutMs?: number) =>
  run("shopify", [...args, "--store", STORE!], { timeoutMs });

async function git(args: string[]): Promise<string> {
  const { stdout } = await run("git", args);
  return stdout.trim();
}

async function ensureGitRepo(): Promise<void> {
  try {
    await git(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    await git(["init"]);
    await git(["add", "-A"]);
    try {
      await git([
        "-c", "user.name=shopify-theme-mcp",
        "-c", "user.email=mcp@local",
        "commit", "-m", "Initial snapshot (shopify-theme-mcp)",
      ]);
    } catch {
      /* empty dir — fine */
    }
  }
}

async function gitCommit(message: string): Promise<string> {
  await ensureGitRepo();
  await git(["add", "-A"]);
  try {
    await git([
      "-c", "user.name=shopify-theme-mcp",
      "-c", "user.email=mcp@local",
      "commit", "-m", `[claude] ${message}`,
    ]);
    return await git(["rev-parse", "--short", "HEAD"]);
  } catch {
    return "(no changes to commit)";
  }
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errorResult(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `ERROR: ${msg}` }], isError: true };
}

/**
 * Wrap a handler so thrown errors become MCP error results instead of crashes,
 * and serialize all tool calls through a queue so concurrent calls can't race
 * on the git index or the filesystem.
 */
let queue: Promise<unknown> = Promise.resolve();
function handler<A>(fn: (args: A) => Promise<{ content: any[] }>) {
  return (args: A) => {
    const result = queue.then(async () => {
      try {
        return await fn(args);
      } catch (e) {
        return errorResult(e);
      }
    });
    queue = result.catch(() => {});
    return result;
  };
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function isProbablyText(filename: string): boolean {
  return !/\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|pdf|zip)$/i.test(
    filename
  );
}

// ---------------------------------------------------------------------------
// Hidden/disabled content detection (Shopify template & section-group JSON)
//
// Template JSON (templates/*.json) and section-group JSON (sections/*.json)
// mark hidden sections/blocks with "disabled": true. These helpers map those
// to line ranges so search/patch/read can skip or block them.
// ---------------------------------------------------------------------------

interface HiddenRange {
  startLine: number;
  endLine: number;
  label: string;
}

function isTemplateJson(rel: string): boolean {
  const p = rel.replace(/\\/g, "/");
  return /\.json$/i.test(p) && (p.startsWith("templates/") || p.startsWith("sections/"));
}

/** Index of the '}' matching the '{' at openIdx (string-aware). */
function braceExtent(text: string, openIdx: number): number {
  let depth = 0,
    inStr = false,
    esc = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return text.length - 1;
}

/** Find `"key": { ... }` within [from, to); returns char range of the object. */
function findKeyObject(
  text: string,
  key: string,
  from: number,
  to: number
): { start: number; end: number } | null {
  const needle = JSON.stringify(key);
  let idx = text.indexOf(needle, from);
  while (idx !== -1 && idx < to) {
    let j = idx + needle.length;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] === ":") {
      j++;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "{") return { start: idx, end: braceExtent(text, j) };
    }
    idx = text.indexOf(needle, idx + 1);
  }
  return null;
}

function lineOf(text: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** Line ranges of all disabled sections/blocks in a template/section-group JSON. */
function getHiddenRanges(content: string): HiddenRange[] {
  let data: any;
  try {
    data = JSON.parse(content);
  } catch {
    return [];
  }
  const sections = data?.sections;
  if (!sections || typeof sections !== "object") return [];
  const sectionsObj = findKeyObject(content, "sections", 0, content.length);
  if (!sectionsObj) return [];
  const ranges: HiddenRange[] = [];
  for (const [secId, sec] of Object.entries<any>(sections)) {
    const secRange = findKeyObject(content, secId, sectionsObj.start, sectionsObj.end);
    if (!secRange) continue;
    if (sec?.disabled === true) {
      ranges.push({
        startLine: lineOf(content, secRange.start),
        endLine: lineOf(content, secRange.end),
        label: `disabled section "${secId}"${sec?.type ? ` (type: ${sec.type})` : ""}`,
      });
      continue; // whole section hidden — block granularity unnecessary
    }
    const blocks = sec?.blocks;
    if (blocks && typeof blocks === "object") {
      const blocksRange = findKeyObject(content, "blocks", secRange.start, secRange.end);
      if (!blocksRange) continue;
      for (const [blockId, block] of Object.entries<any>(blocks)) {
        if (block?.disabled === true) {
          const bRange = findKeyObject(content, blockId, blocksRange.start, blocksRange.end);
          if (bRange)
            ranges.push({
              startLine: lineOf(content, bRange.start),
              endLine: lineOf(content, bRange.end),
              label: `disabled block "${blockId}" in section "${secId}"`,
            });
        }
      }
    }
  }
  return ranges;
}

function hiddenLabelAt(ranges: HiddenRange[], line: number): string | null {
  for (const r of ranges) if (line >= r.startLine && line <= r.endLine) return r.label;
  return null;
}

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

function buildServer(): McpServer {
const server = new McpServer(
  { name: "shopify-theme-mcp", version: "1.1.0" },
  {
    instructions: `
This server edits a Shopify theme. There are two distinct edit modes — identify which one applies before touching anything:

## MODE 1: CONTENT EDITS (default)
Requests like "change the headline on the product page", "update the top text", "fix the button copy" are CONTENT edits.
- Target the page's TEMPLATE JSON file, not liquid files. Product pages: templates/product.<suffix>.json (a product with a custom layout has its own product template JSON). Homepage: templates/index.json. Other pages: templates/page.*.json, templates/collection.*.json.
- The text almost always exists verbatim inside the template JSON as a section/block setting (often inside embedded HTML). Workflow: search_files for the visible text → confirm it's in a templates/*.json file → patch_file just that string. Do NOT modify .liquid files for content edits.
- If the text appears in both a template JSON and a liquid file, the JSON is the live content; edit the JSON.

## MODE 2: THEME/CODE EDITS (explicit only)
Only when explicitly asked to "add a custom section", "create a snippet", "change the CSS/layout" — then work in sections/, snippets/, assets/, layout/.

## TERMINOLOGY — page-local vs global
- "header text", "top text", "headline", "title" of a PAGE = the topmost text within that page's OWN template sections. It NEVER means the global site header, the announcement bar, or layout/theme.liquid.
- Only touch global elements when explicitly named: "site header", "navigation", "announcement bar", "footer".

## HIDDEN/DISABLED CONTENT — enforced by the server
- This theme contains many hidden ("disabled": true) sections and blocks. The user is always talking about VISIBLE content unless they say otherwise.
- search_files automatically skips matches in hidden content and reports what it skipped. patch_file will refuse to edit hidden content. Do not pass include_hidden/allow_hidden unless the user explicitly asks to work on hidden content.
- If search finds the target text only in hidden content, tell the user and ask — the visible text they mean may be worded differently.

## SAFETY WORKFLOW
- search_files first; read only the relevant region; prefer patch_file over write_file.
- After edits: theme_push to an unpublished copy and share the preview URL. Never push live or publish without explicit user confirmation.
`.trim(),
  }
);

server.registerTool(
  "list_themes",
  {
    title: "List themes",
    description:
      "List all themes in the store with their IDs and roles (live, unpublished, development). Use this first to find theme IDs.",
    inputSchema: {},
  },
  handler(async () => {
    const { stdout } = await shopify(["theme", "list", "--json"], 120_000);
    return text(stdout.trim() || "(empty response)");
  })
);

server.registerTool(
  "theme_pull",
  {
    title: "Pull theme",
    description:
      "Download a theme's files from Shopify into the local theme directory and snapshot the result in git. " +
      "Pass theme_id (from list_themes); omit to pull the LIVE theme. Run this before starting an editing session so local files are fresh.",
    inputSchema: {
      theme_id: z
        .string()
        .optional()
        .describe("Theme ID to pull. Omit to pull the live theme."),
      only: z
        .string()
        .optional()
        .describe(
          'Optional glob to pull only matching files, e.g. "sections/*.liquid"'
        ),
    },
  },
  handler(async ({ theme_id, only }) => {
    await fs.mkdir(THEME_ROOT, { recursive: true });
    const args = ["theme", "pull", "--force", "--path", THEME_ROOT];
    if (theme_id) args.push("--theme", theme_id);
    else args.push("--live");
    if (only) args.push("--only", only);
    const { stdout, stderr } = await shopify(args, 600_000);
    const commit = await gitCommit(
      `theme pull (${theme_id ? `theme ${theme_id}` : "live"}${only ? `, only ${only}` : ""})`
    );
    return text(
      `Pull complete. Git snapshot: ${commit}\n\n${stdout}\n${stderr}`.trim()
    );
  })
);

server.registerTool(
  "list_files",
  {
    title: "List theme files",
    description:
      "List files in the local theme directory. Optionally filter with a substring or simple pattern (e.g. 'sections/', '.liquid', 'countdown').",
    inputSchema: {
      filter: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter on the relative path"),
    },
  },
  handler(async ({ filter }) => {
    const out: string[] = [];
    const needle = filter?.toLowerCase();
    for await (const file of walk(THEME_ROOT)) {
      const rel = path.relative(THEME_ROOT, file);
      if (!needle || rel.toLowerCase().includes(needle)) out.push(rel);
    }
    out.sort();
    if (out.length === 0)
      return text(
        filter
          ? `No files matching "${filter}". Has theme_pull been run?`
          : "Theme directory is empty. Run theme_pull first."
      );
    return text(`${out.length} files:\n` + out.join("\n"));
  })
);

server.registerTool(
  "read_file",
  {
    title: "Read theme file",
    description:
      "Read a theme file's contents with line numbers. For large files, pass start_line/end_line to read a slice. Use search_files first to locate the relevant region.",
    inputSchema: {
      filename: z
        .string()
        .describe("Theme-relative path, e.g. sections/header.liquid"),
      start_line: z.number().int().min(1).optional(),
      end_line: z.number().int().min(1).optional(),
    },
  },
  handler(async ({ filename, start_line, end_line }) => {
    const abs = safePath(filename);
    if (!isProbablyText(filename))
      return text(`${filename} is a binary asset; not displaying contents.`);
    const raw = await fs.readFile(abs, "utf8");
    const lines = raw.split("\n");
    const from = (start_line ?? 1) - 1;
    const to = end_line ?? lines.length;
    const slice = lines
      .slice(from, to)
      .map((l, i) => `${String(from + i + 1).padStart(5)}| ${l}`)
      .join("\n");
    let header = `// ${filename} (${lines.length} lines total, showing ${from + 1}-${Math.min(
      to,
      lines.length
    )})\n`;
    if (isTemplateJson(filename)) {
      const hidden = getHiddenRanges(raw);
      if (hidden.length) {
        header +=
          `// ⊘ HIDDEN (not rendered on live site — do not edit unless explicitly asked):\n` +
          hidden
            .map((h) => `//   lines ${h.startLine}-${h.endLine}: ${h.label}`)
            .join("\n") +
          "\n";
      }
    }
    return text(header + slice);
  })
);

server.registerTool(
  "search_files",
  {
    title: "Search theme files",
    description:
      "Search all text files in the theme for a string or JavaScript regex. Returns matching files with line numbers and context. " +
      "Always use this to locate code instead of reading whole files.",
    inputSchema: {
      query: z.string().describe("Text or regex to search for"),
      is_regex: z.boolean().optional().describe("Treat query as a regex (default false)"),
      file_filter: z
        .string()
        .optional()
        .describe("Only search files whose path contains this substring, e.g. 'sections/'"),
      max_results: z.number().int().min(1).max(500).optional(),
      include_hidden: z
        .boolean()
        .optional()
        .describe(
          "Also return matches inside disabled (hidden) sections/blocks in template JSON. Default false — hidden content is skipped."
        ),
    },
  },
  handler(async ({ query, is_regex, file_filter, max_results, include_hidden }) => {
    const limit = max_results ?? 100;
    let pattern: RegExp;
    try {
      pattern = is_regex
        ? new RegExp(query, "i")
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch (e) {
      throw new ToolError(`Invalid regex: ${(e as Error).message}`);
    }
    const results: string[] = [];
    let skippedHidden = 0;
    const skippedLabels = new Set<string>();
    const ff = file_filter?.toLowerCase();
    outer: for await (const file of walk(THEME_ROOT)) {
      const rel = path.relative(THEME_ROOT, file);
      if (ff && !rel.toLowerCase().includes(ff)) continue;
      if (!isProbablyText(rel)) continue;
      let content: string;
      try {
        content = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      const hidden = isTemplateJson(rel) ? getHiddenRanges(content) : [];
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          const label = hidden.length ? hiddenLabelAt(hidden, i + 1) : null;
          if (label && !include_hidden) {
            skippedHidden++;
            skippedLabels.add(`${rel}: ${label}`);
            continue;
          }
          const tag = label ? " [HIDDEN: " + label + "]" : "";
          results.push(`${rel}:${i + 1}:${tag} ${lines[i].trim().slice(0, 200)}`);
          if (results.length >= limit) break outer;
        }
      }
    }
    let out = results.length
      ? `${results.length} match(es)${results.length >= limit ? " (truncated)" : ""}:\n` +
        results.join("\n")
      : `No visible matches for "${query}".`;
    if (skippedHidden > 0) {
      out +=
        `\n\n⊘ Skipped ${skippedHidden} match(es) inside hidden/disabled content:\n  - ` +
        [...skippedLabels].join("\n  - ") +
        `\nThese are not rendered on the live site. Pass include_hidden=true only if the user explicitly wants hidden content.`;
    }
    return text(out);
  })
);

server.registerTool(
  "write_file",
  {
    title: "Write theme file (full contents)",
    description:
      "Create a new theme file or fully overwrite an existing one, then auto-commit to git. " +
      "For small edits to existing files prefer patch_file — it is safer and cheaper.",
    inputSchema: {
      filename: z.string().describe("Theme-relative path, e.g. snippets/countdown.liquid"),
      content: z.string().describe("Full file contents"),
      message: z.string().optional().describe("Short description of the change for the git log"),
    },
  },
  handler(async ({ filename, content, message }) => {
    const abs = safePath(filename);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const existed = await fs
      .access(abs)
      .then(() => true)
      .catch(() => false);
    await fs.writeFile(abs, content, "utf8");
    const commit = await gitCommit(message ?? `${existed ? "update" : "create"} ${filename}`);
    return text(
      `${existed ? "Updated" : "Created"} ${filename} (${content.length} chars). Git: ${commit}` +
        warnIfUnusualDir(filename) +
        `\n\nLocal only — run theme_push to upload to Shopify.`
    );
  })
);

server.registerTool(
  "patch_file",
  {
    title: "Patch theme file (find & replace)",
    description:
      "Edit an existing theme file by replacing an exact string. old_str must appear exactly once in the file " +
      "(include enough surrounding lines to make it unique). Auto-commits to git. Preferred over write_file for edits.",
    inputSchema: {
      filename: z.string(),
      old_str: z.string().describe("Exact text to replace — must be unique in the file"),
      new_str: z.string().describe("Replacement text (empty string deletes old_str)"),
      message: z.string().optional().describe("Short description for the git log"),
      allow_hidden: z
        .boolean()
        .optional()
        .describe(
          "Required (true) to edit content inside a disabled/hidden section or block. Only set after the user explicitly confirms they want to edit hidden content."
        ),
    },
  },
  handler(async ({ filename, old_str, new_str, message, allow_hidden }) => {
    const abs = safePath(filename);
    const content = await fs.readFile(abs, "utf8");
    const count = content.split(old_str).length - 1;
    if (count === 0)
      throw new ToolError(
        `old_str not found in ${filename}. Read the file again — it may have changed.`
      );
    if (count > 1)
      throw new ToolError(
        `old_str appears ${count} times in ${filename}. Add more surrounding context to make it unique.`
      );
    if (isTemplateJson(filename) && !allow_hidden) {
      const hidden = getHiddenRanges(content);
      if (hidden.length) {
        const matchLine = lineOf(content, content.indexOf(old_str));
        const label = hiddenLabelAt(hidden, matchLine);
        if (label) {
          throw new ToolError(
            `BLOCKED: the target text is inside ${label} — this content is NOT rendered on the live site. ` +
              `The user is almost certainly referring to different, visible text. Re-run search_files for the visible occurrence. ` +
              `If the user explicitly wants to edit this hidden content, retry with allow_hidden=true.`
          );
        }
      }
    }
    await fs.writeFile(abs, content.replace(old_str, new_str), "utf8");
    const commit = await gitCommit(message ?? `patch ${filename}`);
    return text(
      `Patched ${filename}. Git: ${commit}\n\nLocal only — run theme_push to upload to Shopify.`
    );
  })
);

server.registerTool(
  "delete_file",
  {
    title: "Delete theme file",
    description: "Delete a local theme file and auto-commit. Note: theme_push does not delete remote files unless you push with the CLI's --nodelete disabled; mention this to the user.",
    inputSchema: {
      filename: z.string(),
      message: z.string().optional(),
    },
  },
  handler(async ({ filename, message }) => {
    const abs = safePath(filename);
    await fs.unlink(abs);
    const commit = await gitCommit(message ?? `delete ${filename}`);
    return text(`Deleted ${filename} locally. Git: ${commit}`);
  })
);

server.registerTool(
  "theme_push",
  {
    title: "Push theme to Shopify",
    description:
      "Upload the local theme directory to Shopify.\n" +
      "- Default: push to an UNPUBLISHED copy (safe; returns a preview URL).\n" +
      "- Pass theme_id to push to a specific existing theme.\n" +
      "- Pushing to the LIVE theme is BLOCKED unless allow_live=true. Only set allow_live after the user explicitly confirms.",
    inputSchema: {
      theme_id: z
        .string()
        .optional()
        .describe("Existing theme ID to push to. Omit to create a new unpublished theme."),
      new_theme_name: z
        .string()
        .optional()
        .describe("Name for the new unpublished theme (used when theme_id is omitted)"),
      only: z.string().optional().describe('Optional glob, e.g. "sections/hero.liquid"'),
      allow_live: z
        .boolean()
        .optional()
        .describe("Must be true to push to the live/published theme"),
    },
  },
  handler(async ({ theme_id, new_theme_name, only, allow_live }) => {
    // Safety gate: check whether the target is the live theme.
    if (theme_id) {
      const { stdout } = await shopify(["theme", "list", "--json"], 120_000);
      let themes: any[] = [];
      try {
        themes = JSON.parse(stdout);
      } catch {
        /* if parsing fails, fall through — CLI itself will error on bad IDs */
      }
      const target = themes.find((t) => String(t.id) === String(theme_id));
      if (target?.role === "main" || target?.role === "live") {
        if (!allow_live) {
          throw new ToolError(
            `Theme ${theme_id} ("${target.name}") is the LIVE theme. ` +
              `Push blocked. Ask the user to confirm, then retry with allow_live=true — ` +
              `or push to an unpublished copy instead (omit theme_id).`
          );
        }
      }
    }
    const args = ["theme", "push", "--force", "--json", "--path", THEME_ROOT];
    if (theme_id) {
      args.push("--theme", theme_id);
      if (allow_live) args.push("--allow-live");
    } else {
      args.push("--unpublished");
      args.push("--theme", new_theme_name ?? `claude-edit-${new Date().toISOString().slice(0, 10)}`);
    }
    if (only) args.push("--only", only);
    const { stdout, stderr } = await shopify(args, 600_000);
    return text(
      `Push complete.\n${stdout}\n${stderr}`.trim() +
        `\n\nIf a preview URL is shown above, share it with the user before publishing.`
    );
  })
);

server.registerTool(
  "publish_theme",
  {
    title: "Publish theme (make it live)",
    description:
      "Make an unpublished theme the live storefront theme. DESTRUCTIVE for the current live theme's status — " +
      "only call after the user has previewed the theme and explicitly asked to publish. confirm must be true.",
    inputSchema: {
      theme_id: z.string(),
      confirm: z.boolean().describe("Must be true; set only after explicit user confirmation"),
    },
  },
  handler(async ({ theme_id, confirm }) => {
    if (!confirm)
      throw new ToolError("Publish blocked: confirm=true required after explicit user approval.");
    const { stdout, stderr } = await shopify(
      ["theme", "publish", "--theme", theme_id, "--force"],
      120_000
    );
    return text(`Published theme ${theme_id}.\n${stdout}\n${stderr}`.trim());
  })
);

server.registerTool(
  "git_history",
  {
    title: "Show edit history",
    description: "Show recent git commits for the local theme (every edit auto-commits).",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  handler(async ({ limit }) => {
    await ensureGitRepo();
    const log = await git([
      "log",
      `-${limit ?? 15}`,
      "--pretty=format:%h  %ad  %s",
      "--date=format:%Y-%m-%d %H:%M",
    ]);
    return text(log || "No commits yet.");
  })
);

server.registerTool(
  "git_revert_file",
  {
    title: "Revert a file to a previous commit",
    description:
      "Restore one file to its state at a given commit (from git_history), then commit the revert. Use to undo a bad edit.",
    inputSchema: {
      filename: z.string(),
      commit: z.string().describe("Commit hash from git_history, e.g. 'a1b2c3d'"),
    },
  },
  handler(async ({ filename, commit }) => {
    safePath(filename); // validate path
    await git(["checkout", commit, "--", filename]);
    const newCommit = await gitCommit(`revert ${filename} to ${commit}`);
    return text(
      `Reverted ${filename} to ${commit}. Git: ${newCommit}\n\nLocal only — run theme_push to upload.`
    );
  })
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

return server;
}

// ---------------------------------------------------------------------------
// Boot — stdio (default, for Claude Desktop) or HTTP (for remote hosting
// behind a Cloudflare Tunnel). Set MCP_TRANSPORT=http to enable HTTP mode.
//
// HTTP mode env:
//   PORT        listen port (default 8787)
//   MCP_SECRET  required secret path segment; endpoint becomes /<secret>/mcp
//               so the endpoint is unguessable without the full URL
// ---------------------------------------------------------------------------

if (process.env.MCP_TRANSPORT === "http") {
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const http = await import("node:http");

  const PORT = Number(process.env.PORT ?? 8787);
  const SECRET = process.env.MCP_SECRET;
  if (!SECRET || SECRET.length < 16) {
    console.error(
      "HTTP mode requires MCP_SECRET (>=16 chars). Generate one with: openssl rand -hex 24"
    );
    process.exit(1);
  }
  const MCP_PATH = `/${SECRET}/mcp`;

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }
      if (url.pathname !== MCP_PATH) {
        res.writeHead(404).end();
        return;
      }
      if (req.method !== "POST") {
        // Stateless mode: no SSE stream / no sessions to terminate.
        res
          .writeHead(405, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Method not allowed" },
              id: null,
            })
          );
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;

      // Stateless: fresh server + transport per request. The module-level
      // `queue` mutex still serializes all filesystem/git/CLI work globally.
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error("Request error:", e);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          })
        );
      }
    }
  });

  httpServer.listen(PORT, "127.0.0.1", () => {
    console.error(
      `shopify-theme-mcp (http) ready — store: ${STORE}, theme dir: ${THEME_ROOT}\n` +
        `Listening on 127.0.0.1:${PORT}, endpoint: ${MCP_PATH}`
    );
  });
} else {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `shopify-theme-mcp (stdio) ready — store: ${STORE}, theme dir: ${THEME_ROOT}`
  );
}
