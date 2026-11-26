import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import lottie, { type AnimationItem } from "lottie-web";
import { api } from "./api";

// Animated artwork: Noto Emoji Animation, SIL Open Font License 1.1.
// Files live in public/emoji next to LICENSE.
export const SMILEYS = [
  "smile",
  "grin",
  "laugh",
  "wink",
  "tongue",
  "kiss",
  "love",
  "blush",
  "smirk",
  "cool",
  "wow",
  "think",
  "neutral",
  "confused",
  "sad",
  "cry",
  "angry",
  "sick",
  "sleep",
  "yawn",
  "halo",
  "zany",
  "melt",
  "partyface",
  "plead",
  "salute",
  "starstruck",
  "shush",
  "nerd",
  "heart",
  "wave",
  "clap",
  "thumbsup",
  "ok",
  "peace",
  "pray",
  "eyes",
  "fire",
  "party",
  "rocket",
  "hundred",
  "sparkles",
  "star",
] as const;

export type SmileyName = (typeof SMILEYS)[number];

const GLYPH: Record<SmileyName, string> = {
  smile: "🙂",
  grin: "😀",
  laugh: "😂",
  wink: "😉",
  tongue: "😜",
  kiss: "😘",
  love: "😍",
  blush: "😊",
  smirk: "😏",
  cool: "😎",
  wow: "😮",
  think: "🤔",
  neutral: "😐",
  confused: "😕",
  sad: "🙁",
  cry: "😭",
  angry: "😠",
  sick: "🤒",
  sleep: "😴",
  yawn: "🥱",
  halo: "😇",
  zany: "🤪",
  melt: "🫠",
  partyface: "🥳",
  plead: "🥺",
  salute: "🫡",
  starstruck: "🤩",
  shush: "🤫",
  nerd: "🤓",
  heart: "❤️",
  wave: "👋",
  clap: "👏",
  thumbsup: "👍",
  ok: "👌",
  peace: "✌️",
  pray: "🙏",
  eyes: "👀",
  fire: "🔥",
  party: "🎉",
  rocket: "🚀",
  hundred: "💯",
  sparkles: "✨",
  star: "⭐",
};

const cache = new Map<string, Promise<object | null>>();

function loadEmoji(name: string): Promise<object | null> {
  const hit = cache.get(name);
  if (hit) return hit;
  const url = new URL(`emoji/${name}.json`, document.baseURI).href;
  const pending = fetch(url).then((res) => (res.ok ? res.json() as Promise<object> : null)).catch(() => null);
  cache.set(name, pending);
  return pending;
}

export function Smiley({ name, size = 28 }: { name: string; size?: number }) {
  const host = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  const glyph = GLYPH[name as SmileyName] || "";
  useEffect(() => {
    const node = host.current;
    if (!node || !(SMILEYS as readonly string[]).includes(name)) return;
    let dead = false;
    let anim: AnimationItem | undefined;
    const reduce = document.documentElement.dataset.motion === "reduce";
    void loadEmoji(name).then((data) => {
      if (dead || !data || !host.current) return;
      anim = lottie.loadAnimation({
        container: host.current,
        renderer: "svg",
        loop: !reduce,
        autoplay: !reduce,
        animationData: structuredClone(data),
        rendererSettings: { preserveAspectRatio: "xMidYMid meet" },
      });
      anim.addEventListener("DOMLoaded", () => {
        if (!dead) setReady(true);
      });
    });
    return () => {
      dead = true;
      anim?.destroy();
      setReady(false);
    };
  }, [name]);
  return (
    <span className="sy-wrap" style={{ width: size, height: size }} title={name}>
      {!ready && <span className="sy-fallback" aria-hidden>{glyph}</span>}
      <span ref={host} className="sy-play" />
    </span>
  );
}

const URL_RE = /(https?:\/\/[^\s<]+)/gi;
const GIF_RE = /\.gif(\?|#|$)/i;
const IMG_RE = /\.(png|jpe?g|webp|bmp|avif|svg|ico|jfif)(\?|#|$)/i;
const VID_RE = /\.(mp4|webm|mov|mkv|ogv|m4v|avi|3gp|mpeg|mpg)(\?|#|$)/i;

function openHref(href: string, event?: MouseEvent): void {
  event?.preventDefault();
  void api.invoke("openExternal", { url: href });
}

function trimUrl(raw: string): string {
  return raw.replace(/[),.;!?]+$/g, "");
}

function youtubeId(url: URL): string {
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || "";
  if (!host.endsWith("youtube.com") && !host.endsWith("youtube-nocookie.com")) return "";
  if (url.searchParams.get("v")) return url.searchParams.get("v") || "";
  const parts = url.pathname.split("/").filter(Boolean);
  if (["embed", "shorts", "live", "v"].includes(parts[0] || "")) return parts[1] || "";
  return "";
}

function hostPreview(url: string): { kind: "gif" | "image" | "file-video" | "host-video"; thumb?: string; label?: string } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").replace(/^m\./, "");
    const path = parsed.pathname;
    if (GIF_RE.test(path) || /giphy\.com|tenor\.com|media\.tenor/i.test(host)) return { kind: "gif" };
    if (IMG_RE.test(path) || /i\.imgur\.com|pbs\.twimg\.com|cdninstagram/i.test(host)) return { kind: "image" };
    if (VID_RE.test(path)) return { kind: "file-video" };
    const yt = youtubeId(parsed);
    if (yt) return { kind: "host-video", thumb: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`, label: "YouTube" };
    if (host.endsWith("vimeo.com")) {
      const id = path.split("/").filter(Boolean).pop() || "";
      if (/^\d+$/.test(id)) return { kind: "host-video", thumb: `https://vumbnail.com/${id}.jpg`, label: "Vimeo" };
    }
    if (host.endsWith("rutube.ru") && /\/video\//.test(path)) {
      const id = path.split("/").filter(Boolean)[1] || "";
      return { kind: "host-video", thumb: id ? `https://rutube.ru/api/video/${id}/thumbnail/?redirect=1` : undefined, label: "Rutube" };
    }
    if (host.includes("vk.com") || host.includes("vkvideo.ru") || host.includes("vk.ru")) {
      if (/video|clip/i.test(path + parsed.search)) return { kind: "host-video", label: "VK" };
    }
    if (host.endsWith("twitch.tv") && (/\/videos\//.test(path) || parsed.searchParams.get("video"))) return { kind: "host-video", label: "Twitch" };
    if (host.includes("dailymotion.com") && /\/video\//.test(path)) return { kind: "host-video", label: "Dailymotion" };
    if (host.includes("tiktok.com")) return { kind: "host-video", label: "TikTok" };
    if (host.includes("instagram.com") && /\/(reel|p|tv)\//.test(path)) return { kind: "host-video", label: "Instagram" };
    if ((host === "x.com" || host.endsWith("twitter.com")) && /\/status\//.test(path)) return { kind: "host-video", label: "X" };
    if (host.includes("ok.ru") && /video/.test(path)) return { kind: "host-video", label: "OK" };
    if (host.includes("yandex.") && /video/.test(host + path)) return { kind: "host-video", label: "Яндекс" };
    if (host.includes("mail.ru") && /video/.test(path)) return { kind: "host-video", label: "Mail.ru" };
    if (host.endsWith("coub.com")) return { kind: "host-video", label: "Coub" };
    if (host.includes("streamable.com")) return { kind: "host-video", label: "Streamable" };
    if (host.includes("bilibili.com")) return { kind: "host-video", label: "Bilibili" };
    return null;
  } catch {
    return null;
  }
}

function MediaLink({ href }: { href: string }) {
  const url = trimUrl(href);
  const preview = hostPreview(url);
  return (
    <span className="link-media">
      {preview?.kind === "gif" && <img className="chat-embed gif" src={url} alt="" onClick={(event) => openHref(url, event)} />}
      {preview?.kind === "image" && <img className="chat-embed" src={url} alt="" onClick={(event) => openHref(url, event)} />}
      {preview?.kind === "file-video" && <video className="chat-embed" src={url} autoPlay loop muted playsInline controls={false} onClick={(event) => openHref(url, event)} />}
      {preview?.kind === "host-video" && (
        <span className="link-card" onClick={(event) => openHref(url, event)}>
          <span className="play-mark">{preview.thumb ? <img src={preview.thumb} alt={preview.label || ""} /> : <span className="chat-embed" />}</span>
        </span>
      )}
      <a href={url} onClick={(event) => openHref(url, event)}>{url}</a>
    </span>
  );
}

function withLinks(text: string, key: string): ReactNode[] {
  const bits = text.split(URL_RE);
  return bits.map((bit, index) => {
    if (/^https?:\/\//i.test(bit)) return <MediaLink key={`${key}-${index}`} href={bit} />;
    return <span key={`${key}-${index}`}>{bit}</span>;
  });
}

export function renderRichText(text: string, size = 22): ReactNode[] {
  const parts = text.split(/:([a-z]+):/g);
  return parts.flatMap((part, index) => {
    if (index % 2 === 1 && (SMILEYS as readonly string[]).includes(part)) {
      return [<Smiley key={index} name={part} size={size} />];
    }
    return withLinks(part, String(index));
  });
}
