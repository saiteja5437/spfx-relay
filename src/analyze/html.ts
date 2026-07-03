import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5TextNode = DefaultTreeAdapterMap['textNode'];

export interface HtmlAssetRef {
  kind: 'stylesheet' | 'script' | 'image';
  path: string;
  line: number;
}

export interface InlineScript {
  content: string;
  /** Added to 1-based line numbers within the script text to get HTML file lines. */
  lineOffset: number;
}

export interface HtmlEventAttribute {
  event: string;
  target: string | null;
  line: number;
}

export interface HtmlFacts {
  assets: HtmlAssetRef[];
  inlineScripts: InlineScript[];
  eventAttributes: HtmlEventAttribute[];
}

/** Extracts asset references, inline scripts, and inline on* handlers from HTML. */
export function analyzeHtml(html: string): HtmlFacts {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const facts: HtmlFacts = { assets: [], inlineScripts: [], eventAttributes: [] };
  walk(document, facts);
  return facts;
}

function walk(node: P5Node, facts: HtmlFacts): void {
  if (isElement(node)) {
    collectFromElement(node, facts);
  }
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      walk(child, facts);
    }
  }
}

function isElement(node: P5Node): node is P5Element {
  return 'tagName' in node;
}

function attr(el: P5Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function elementLine(el: P5Element): number {
  return el.sourceCodeLocation?.startLine ?? 0;
}

function attributeLine(el: P5Element, name: string): number {
  return el.sourceCodeLocation?.attrs?.[name]?.startLine ?? elementLine(el);
}

function collectFromElement(el: P5Element, facts: HtmlFacts): void {
  switch (el.tagName) {
    case 'link': {
      const href = attr(el, 'href');
      if (href && attr(el, 'rel')?.toLowerCase() === 'stylesheet') {
        facts.assets.push({ kind: 'stylesheet', path: href, line: elementLine(el) });
      }
      break;
    }
    case 'script': {
      const src = attr(el, 'src');
      if (src) {
        facts.assets.push({ kind: 'script', path: src, line: elementLine(el) });
      } else {
        const text = el.childNodes.find((n): n is P5TextNode => n.nodeName === '#text');
        if (text && text.value.trim().length > 0) {
          facts.inlineScripts.push({
            content: text.value,
            lineOffset: (text.sourceCodeLocation?.startLine ?? 1) - 1,
          });
        }
      }
      break;
    }
    case 'img': {
      const src = attr(el, 'src');
      if (src) {
        facts.assets.push({ kind: 'image', path: src, line: elementLine(el) });
      }
      break;
    }
  }

  for (const a of el.attrs) {
    if (a.name.startsWith('on') && a.name.length > 2) {
      facts.eventAttributes.push({
        event: a.name.slice(2),
        target: attr(el, 'id') ?? el.tagName,
        line: attributeLine(el, a.name),
      });
    }
  }
}
