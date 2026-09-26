import type { AssistantTool, ChatMessage, FilePart, ImagePart, Usage } from '../core/types';

/** `view.color_by` → `View · color by`: a tool name for people, when the tool has no title. */
export function humaniseToolName(name: string): string {
  const segments = name
    .split(/[./:]/)
    .map((s) => s.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase())
    .filter(Boolean);
  if (segments.length === 0) return name;
  segments[0] = segments[0].charAt(0).toUpperCase() + segments[0].slice(1);
  return segments.join(' · ');
}

/** The title a tool call shows: the host's `title`, else the humanised name. */
export function toolTitle(name: string, tools: readonly Pick<AssistantTool, 'name' | 'title'>[]): string {
  return tools.find((t) => t.name === name)?.title ?? humaniseToolName(name);
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return value.length > 40 ? `${value.slice(0, 39)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.every((v) => typeof v !== 'object' || v === null) && value.length <= 4 ? `[${value.map(scalar).join(', ')}]` : `${value.length} items`;
  return '{…}';
}

/** One line of a tool call's arguments: `well: F-11 A, from: 3000, to: 3100`. */
export function argsSummary(args: unknown, max = 90): string {
  if (args === undefined || args === null) return '';
  let text: string;
  if (typeof args !== 'object' || Array.isArray(args)) text = scalar(args);
  else
    text = Object.entries(args as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${scalar(v)}`)
      .join(', ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 420 ms · 1.2 s · 1 m 04 s */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} m ${String(s).padStart(2, '0')} s`;
}

/** "Thought for 12s" style: whole seconds, at least 1. */
export function formatSeconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** just now · 5 min ago · 3 h ago · Yesterday · Mon · 12 Mar */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const date = new Date(ts);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return `${Math.floor(diff / 3_600_000)} h ago`;
  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (diff < 6 * 86_400_000) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
}

/** 1,234 → 1.2k */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "1.2k in · 340 out" for the message footer, or '' without usage. */
export function formatUsage(usage: Usage | undefined): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.inputTokens) parts.push(`${compactNumber(usage.inputTokens)} in`);
  if (usage.outputTokens) parts.push(`${compactNumber(usage.outputTokens)} out`);
  return parts.join(' · ');
}

/** Pretty JSON for the tool details (strings as they are). */
export function prettyJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The text parts of a message, joined: what "Copy" copies. */
export function messageText(message: ChatMessage): string {
  return message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/** Saves `text` as a file through a temporary link. */
export function downloadText(filename: string, text: string, mediaType = 'text/markdown'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mediaType};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name from a thread title: `hugin-gamma-ray.md`. */
export function slugFileName(title: string, ext: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'conversation'}.${ext}`;
}

// ------------------------------------------------------------------ attachments

/** Text files the composer inlines, by extension. */
export const TEXT_FILE_EXTENSIONS = ['csv', 'tsv', 'las', 'txt', 'json', 'md', 'xml', 'log', 'yaml', 'yml'];
/** What the kit sends of a text file; longer files are cut and marked `truncated`. */
export const MAX_TEXT_FILE_BYTES = 200 * 1024;
/** Images larger than this (either side, in px) are scaled down before sending. */
const MAX_IMAGE_EDGE = 2048;

export type Attached = { kind: 'image'; part: ImagePart } | { kind: 'file'; part: FilePart } | { kind: 'rejected'; name: string; reason: string };

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function isTextLike(file: File): boolean {
  return file.type.startsWith('text/') || file.type === 'application/json' || file.type === 'application/xml' || TEXT_FILE_EXTENSIONS.includes(extensionOf(file.name));
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function downscale(file: File): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), 'image/jpeg', 0.88));
}

/** Reads a dropped, pasted or picked file into an image or a text-file part. */
export async function readAttachment(file: File): Promise<Attached> {
  const name = file.name || 'pasted';
  if (file.type.startsWith('image/')) {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) return { kind: 'rejected', name, reason: 'Only PNG, JPEG, WebP and GIF images can be sent.' };
    try {
      const blob = await downscale(file);
      const url = await readAsDataUrl(blob);
      const comma = url.indexOf(',');
      return { kind: 'image', part: { type: 'image', mediaType: blob.type || file.type, data: url.slice(comma + 1), name } };
    } catch {
      return { kind: 'rejected', name, reason: 'The image could not be read.' };
    }
  }
  if (isTextLike(file)) {
    const truncated = file.size > MAX_TEXT_FILE_BYTES;
    const text = await (truncated ? file.slice(0, MAX_TEXT_FILE_BYTES) : file).text();
    return { kind: 'file', part: { type: 'file', name, mediaType: file.type || 'text/plain', text, ...(truncated ? { truncated: true } : {}) } };
  }
  return { kind: 'rejected', name, reason: `${extensionOf(name).toUpperCase() || 'This'} files are not supported. Attach images or text files (${TEXT_FILE_EXTENSIONS.slice(0, 6).join(', ')}…).` };
}

/** 12.4 KB */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
