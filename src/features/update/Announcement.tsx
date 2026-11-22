import { createElement, Fragment, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Bulletin } from "../../api";
import { toastError } from "../../ui/Toast";
import "./announcement.css";

function permittedUrl(raw: string, base: string, image: boolean): string | null {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
    const host = url.hostname;
    const official = host === "roblox.com" || host.endsWith(".roblox.com");
    const github = host === "github.com" && /^\/(?:Unknown69511\/UnknownAlt\/|user-attachments\/assets\/)/i.test(url.pathname);
    if (image) {
      return (host.endsWith(".rbxcdn.com") || host === "user-images.githubusercontent.com" ||
        (host === "doy2mn9upadnk.cloudfront.net" && url.pathname.startsWith("/images/emoji/")) ||
        host === "devforum-uploads.s3.dualstack.us-east-2.amazonaws.com" ||
        (host === "devforum.roblox.com" && /^\/(?:secure-uploads\/)?uploads\//.test(url.pathname)) ||
        (github && url.pathname.startsWith("/user-attachments/assets/"))) ? url.href : null;
    }
    return (official && (
      host === "www.roblox.com" || host === "create.roblox.com" ||
      (host === "devforum.roblox.com" && url.pathname.startsWith("/t/")) ||
      (host === "about.roblox.com" && url.pathname.startsWith("/newsroom/"))
    )) || (github && !url.pathname.startsWith("/user-attachments/")) ? url.href : null;
  } catch { return null; }
}

const tags = new Set(["p", "ul", "ol", "li", "strong", "b", "em", "i", "code", "pre", "br", "hr",
  "blockquote", "h2", "h3", "h4", "h5", "table", "thead", "tbody", "th", "tr", "td", "div", "span", "figure", "figcaption"]);
const omit = new Set(["script", "style", "iframe", "object", "form", "svg", "video", "audio", "template", "noscript"]);

function ArticleImage({ urls, alt }: { urls: string[]; alt: string }) {
  const [index, next] = useState(0);
  return urls[index] ? <img src={urls[index]} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
    onError={() => next((value) => value + 1)} /> : <span className="text-xs text-fg-2">Image unavailable from the source.</span>;
}

function readHtml(html: string, base: string): ReactNode {
  const template = document.createElement("template");
  template.innerHTML = html;
  const seen = new Set<string>();
  const visit = (node: Node, index: number, depth: number): ReactNode => {
    if (depth > 24) return null;
    if (node.nodeType === Node.TEXT_NODE) return inline(node.textContent ?? "", base);
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const element = node as HTMLElement;
    const tag = element.localName;
    if (omit.has(tag)) return null;
    if (tag === "img") {
      const srcset = (element.getAttribute("srcset") ?? element.getAttribute("data-srcset") ?? "").split(",").map((item) => item.trim().split(/\s+/)[0]).reverse();
      const urls = [...new Set([element.getAttribute("data-src"), element.getAttribute("src"), ...srcset,
        element.closest("a.lightbox")?.getAttribute("href")].flatMap((raw) => raw ? permittedUrl(raw, base, true) ?? [] : []))];
      if (!urls.length || seen.has(urls[0])) return null;
      seen.add(urls[0]);
      return <ArticleImage key={index} urls={urls} alt={element.getAttribute("alt") ?? ""} />;
    }
    if (tag === "br" || tag === "hr") return createElement(tag, { key: index });
    const children = Array.from(element.childNodes, (child, i) => visit(child, i, depth + 1));
    if (tag === "a") {
      const url = permittedUrl(element.getAttribute("href") ?? "", base, false);
      if (url) return <a key={index} href={url} onClick={(e) => { e.preventDefault(); void openUrl(url).catch(toastError); }}>{children}</a>;
    }
    return tags.has(tag) ? createElement(tag === "h2" ? "h3" : tag, { key: index }, children) :
      <Fragment key={index}>{children}</Fragment>;
  };
  return Array.from(template.content.childNodes, (node, i) => visit(node, i, 0));
}

function inline(text: string, base: string): ReactNode {
  return text.split(/(!?\[[^\]\n]*\]\(https?:\/\/[^\s)]+\)|https:\/\/[^\s<>]+?\.(?:png|jpg|jpeg|webp|gif)(?:\?[^\s<>]*)?(?=\s|$)|\*\*[^*\n]+\*\*|`[^`\n]+`)/gi).map((part, i) => {
    const link = /^(!?)\[([^\]]*)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const url = permittedUrl(link[3], base, Boolean(link[1]));
      if (!url) return link[2];
      if (link[1]) return <ArticleImage key={i} urls={[url]} alt={link[2]} />;
      return <a key={i} href={url} onClick={(e) => { e.preventDefault(); void openUrl(url).catch(toastError); }}>{link[2]}</a>;
    }
    if (part.startsWith("https://")) {
      const url = permittedUrl(part, base, true);
      if (url) return <ArticleImage key={i} urls={[url]} alt="Announcement image" />;
    }
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
}

function readMarkdown(markdown: string, base: string): ReactNode {
  return markdown.trim().split(/\r?\n\s*\r?\n/).map((block, i) => {
    const lines = block.split(/\r?\n/);
    if (block.startsWith("```") && block.endsWith("```")) return <pre key={i}><code>{lines.slice(1, -1).join("\n")}</code></pre>;
    return <div key={i}>{lines.map((line, j) => {
      const heading = /^#{1,6}\s+(.+)$/.exec(line);
      if (heading) return <h3 key={j}>{inline(heading[1], base)}</h3>;
      if (/^[-*]\s+/.test(line)) return <p key={j} className="pl-3">• {inline(line.slice(2), base)}</p>;
      if (/^\s*<(?:img|picture|p|div)\b/i.test(line)) return <div key={j}>{readHtml(line, base)}</div>;
      return <p key={j}>{inline(line, base)}</p>;
    })}</div>;
  });
}

export function Announcement({ item }: { item: Bulletin }) {
  if (!item.summary) return <p className="text-fg-2">This source provides the full announcement on its website.</p>;
  return <div className="announcement-body min-w-0 break-words">
    {item.source === "unknownAlt" ? readMarkdown(item.summary, item.url) : readHtml(item.summary, item.url)}
  </div>;
}
