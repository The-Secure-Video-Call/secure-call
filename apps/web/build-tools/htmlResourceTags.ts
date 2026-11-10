// A small HTML start-tag reader shared by the SRI plugin and the build check.
// It is not a full HTML parser: it only handles the markup Vite writes into index.html
// (and the hostile variants the build check must catch). Plain Node can run this file
// (type stripping), so it uses no TypeScript-only syntax such as enums.

export type HtmlStartTag = {
  /** Lower-case tag name, for example `script` or `link`. */
  tagName: string;
  /** Lower-case attribute name to its value (`''` for an attribute without a value). */
  attributes: Map<string, string>;
  /** The tag exactly as written, from `<` to `>`. */
  rawTagText: string;
  /** Index of `<` in the HTML text. */
  startIndex: number;
  /** Index just after `>` in the HTML text. */
  endIndex: number;
  /** For `script` and `style`: the text up to the closing tag. Empty for other tags. */
  innerText: string;
};

const START_TAG_PATTERN = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTRIBUTE_PATTERN = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
// HTML5 ends a comment at the first `-->`, and `<!-->` and `<!--->` are complete empty comments.
const COMMENT_PATTERN = /<!--(?:-?>|[\s\S]*?-->)/g;

/** Replaces HTML comments with spaces of the same length, so indexes stay valid. */
function blankOutComments(html: string): string {
  return html.replace(COMMENT_PATTERN, (comment) => ' '.repeat(comment.length));
}

function readAttributes(attributeText: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of attributeText.matchAll(ATTRIBUTE_PATTERN)) {
    const attributeName = (match[1] ?? '').toLowerCase();
    const attributeValue = match[2] ?? match[3] ?? match[4] ?? '';
    if (!attributes.has(attributeName)) attributes.set(attributeName, attributeValue);
  }
  return attributes;
}

/** Every start tag in the HTML, in document order. Comments are ignored. */
export function findStartTags(html: string): HtmlStartTag[] {
  const htmlWithoutComments = blankOutComments(html);
  const lowerCaseHtmlWithoutComments = htmlWithoutComments.toLowerCase();
  const startTags: HtmlStartTag[] = [];
  for (const match of htmlWithoutComments.matchAll(START_TAG_PATTERN)) {
    const tagName = (match[1] ?? '').toLowerCase();
    const startIndex = match.index;
    const endIndex = startIndex + match[0].length;
    let innerText = '';
    if (tagName === 'script' || tagName === 'style') {
      const closingTagIndex = lowerCaseHtmlWithoutComments.indexOf(`</${tagName}`, endIndex);
      innerText = html.slice(endIndex, closingTagIndex === -1 ? html.length : closingTagIndex);
    }
    startTags.push({
      tagName,
      attributes: readAttributes(match[2] ?? ''),
      rawTagText: html.slice(startIndex, endIndex),
      startIndex,
      endIndex,
      innerText,
    });
  }
  return startTags;
}

/** The `rel` values of a `<link>`, lower-cased. */
export function readLinkRelations(linkTag: HtmlStartTag): string[] {
  return (linkTag.attributes.get('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

const RELATIONS_THAT_LOAD_CODE_OR_STYLE = ['stylesheet', 'modulepreload', 'preload'];

/**
 * The tags the browser can check with `integrity`: every `<script>` and every `<link>` whose
 * `rel` is stylesheet, modulepreload or preload.
 */
export function isIntegrityProtectedTag(startTag: HtmlStartTag): boolean {
  if (startTag.tagName === 'script') return true;
  if (startTag.tagName !== 'link') return false;
  return readLinkRelations(startTag).some((relation) =>
    RELATIONS_THAT_LOAD_CODE_OR_STYLE.includes(relation),
  );
}

/** The file address of a protected tag: `src` for a script, `href` for a link. */
export function readResourceUrl(startTag: HtmlStartTag): string | undefined {
  return startTag.attributes.get(startTag.tagName === 'script' ? 'src' : 'href');
}

/**
 * Turns an address like `/assets/index-abc.js?x#y` into the path inside the build folder
 * (`assets/index-abc.js`). Returns undefined when the address is not a plain same-origin path
 * (another host, `//host/...`, a relative path, `data:`, `javascript:` ...).
 */
export function toBuildFilePath(resourceUrl: string): string | undefined {
  if (!resourceUrl.startsWith('/') || resourceUrl.startsWith('//')) return undefined;
  const pathWithoutQuery = resourceUrl.split(/[?#]/, 1)[0] ?? '';
  const buildFilePath = pathWithoutQuery.slice(1);
  if (buildFilePath === '' || buildFilePath.split('/').includes('..')) return undefined;
  return buildFilePath;
}
