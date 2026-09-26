import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 4000;
const MAX_CHARS = 8000;

function integer(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function validateRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\")) {
    throw new Error("path must be a non-empty relative path using forward slashes");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("path must not contain empty, dot, or parent segments");
  }
  return segments;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("file is not valid UTF-8");
  }
}

export default function sourceWindow(pi) {
  pi.registerTool({
    name: "yhwh_source_window",
    label: "Read source window",
    description: "Read a bounded deterministic character window from a UTF-8 source file under the worker working directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative source path using forward slashes" },
        query: { type: "string", description: "Exact text to locate" },
        occurrence: { type: "integer", minimum: 1, description: "1-based occurrence of query (default 1)" },
        offset: { type: "integer", minimum: 0, description: "Zero-based UTF-16 code-unit offset" },
        maxChars: { type: "integer", minimum: 1, maximum: MAX_CHARS, description: "Maximum returned UTF-16 code units" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(_id, args, _signal, _onUpdate, ctx) {
      try {
        if (!ctx || typeof ctx.cwd !== "string") throw new Error("worker working directory is unavailable");
        const segments = validateRelativePath(args.path);
        const cwd = await realpath(ctx.cwd);
        const candidate = path.resolve(cwd, ...segments);
        if (candidate !== cwd && !candidate.startsWith(`${cwd}${path.sep}`)) throw new Error("path escapes worker working directory");

        // Reject symlinks in every component, including the final file.
        let current = cwd;
        for (const segment of segments) {
          current = path.join(current, segment);
          const stat = await lstat(current);
          if (stat.isSymbolicLink()) throw new Error("symbolic links are not allowed");
          if (current !== candidate && !stat.isDirectory()) throw new Error("path component is not a directory");
          if (current === candidate && !stat.isFile()) throw new Error("path is not a regular file");
        }
        const resolved = await realpath(candidate);
        if (resolved !== candidate || (resolved !== cwd && !resolved.startsWith(`${cwd}${path.sep}`))) {
          throw new Error("resolved path escapes worker working directory or traverses a symlink");
        }
        const bytes = await readFile(candidate);
        if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("file exceeds 8 MiB limit");
        const text = decodeUtf8(bytes);
        const totalLength = text.length;
        const maxChars = args.maxChars === undefined
          ? DEFAULT_MAX_CHARS
          : integer(args.maxChars, "maxChars", { minimum: 1, maximum: MAX_CHARS });
        if (args.query !== undefined && args.offset !== undefined) throw new Error("provide query or offset, not both");

        let start;
        if (args.query !== undefined) {
          if (typeof args.query !== "string" || args.query.length === 0) throw new Error("query must be a non-empty string");
          const occurrence = args.occurrence === undefined ? 1 : integer(args.occurrence, "occurrence", { minimum: 1 });
          start = -1;
          let from = 0;
          for (let count = 0; count < occurrence; count++) {
            start = text.indexOf(args.query, from);
            if (start === -1) throw new Error(`query occurrence ${occurrence} was not found`);
            from = start + args.query.length;
          }
        } else {
          if (args.occurrence !== undefined) throw new Error("occurrence requires query");
          start = args.offset === undefined ? 0 : integer(args.offset, "offset");
          if (start > totalLength) throw new Error("offset exceeds source length");
        }

        const end = Math.min(totalLength, start + maxChars);
        const result = {
          path: args.path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          totalLength,
          start,
          end,
          truncatedStart: start > 0,
          truncatedEnd: end < totalLength,
          text: text.slice(start, end),
        };
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }], isError: true };
      }
    },
  });
}
