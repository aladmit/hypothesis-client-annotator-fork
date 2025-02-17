import { intersectRects, rectContains, rectIntersects } from '../util/geometry';

/**
 * CSS selectors used to find elements that are considered potentially part
 * of the main content of a page.
 */
const contentSelectors = [
  'p',

  // Paragraphs in VitalSource "Great Book" format ebooks.
  '.para',
];

/**
 * Attempt to guess the region of the page that contains the main content.
 *
 * @param {Element} root
 * @return {{ left: number, right: number }|null} -
 *   The left/right content margins or `null` if they could not be determined
 */
export function guessMainContentArea(root) {
  // Maps of (margin X coord, votes) for margin positions.

  /** @type {Map<number,number>} */
  const leftMarginVotes = new Map();

  /** @type {Map<number,number>} */
  const rightMarginVotes = new Map();

  // Gather data about the paragraphs of text in the document.
  //
  // In future we might want to expand this to consider other text containers,
  // since some pages, especially eg. in ebooks, may not have any paragraphs
  // (eg. instead they may only contain tables or lists or headings).
  const contentSelector = contentSelectors.join(',');
  const paragraphs = Array.from(root.querySelectorAll(contentSelector))
    .map(p => {
      // Gather some data about them.
      const rect = p.getBoundingClientRect();
      const textLength = /** @type {string} */ (p.textContent).length;
      return { rect, textLength };
    })
    .filter(({ rect }) => {
      // Filter out hidden paragraphs
      return rect.width > 0 && rect.height > 0;
    })
    // Select the paragraphs containing the most text.
    .sort((a, b) => b.textLength - a.textLength)
    .slice(0, 15);

  // Let these paragraphs "vote" for what the left and right margins of the
  // main content area in the document are.
  paragraphs.forEach(({ rect }) => {
    let leftVotes = leftMarginVotes.get(rect.left) ?? 0;
    leftVotes += 1;
    leftMarginVotes.set(rect.left, leftVotes);

    let rightVotes = rightMarginVotes.get(rect.right) ?? 0;
    rightVotes += 1;
    rightMarginVotes.set(rect.right, rightVotes);
  });

  // Find the margin values with the most votes.
  if (leftMarginVotes.size === 0 || rightMarginVotes.size === 0) {
    return null;
  }

  const leftMargin = [...leftMarginVotes.entries()].sort((a, b) => b[1] - a[1]);
  const rightMargin = [...rightMarginVotes.entries()].sort(
    (a, b) => b[1] - a[1]
  );

  const [leftPos] = leftMargin[0];
  const [rightPos] = rightMargin[0];

  return { left: leftPos, right: rightPos };
}

/** @type {Range} */
let textRectRange;

/**
 * Return the viewport-relative rect occupied by part of a text node.
 *
 * @param {Text} text
 * @param {number} start
 * @param {number} end
 */
function textRect(text, start = 0, end = text.data.length) {
  if (!textRectRange) {
    // Allocate a range only on the first call to avoid the overhead of
    // constructing and maintaining a large number of live ranges.
    textRectRange = document.createRange();
  }
  textRectRange.setStart(text, start);
  textRectRange.setEnd(text, end);
  return textRectRange.getBoundingClientRect();
}

/**
 * Yield all the text node descendants of `root` that intersect `rect`.
 *
 * @param {Element} root
 * @param {DOMRect} rect
 * @return {Generator<Text>}
 */
function* textNodesInRect(root, rect) {
  /** @type {Node|null} */
  let node = root.firstChild;
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = /** @type {Element} */ (node);
      const elementRect = element.getBoundingClientRect();

      // Only examine subtrees which are visible and intersect the viewport.
      if (rectIntersects(elementRect, rect)) {
        yield* textNodesInRect(element, rect);
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = /** @type {Text} */ (node);

      // Skip over text nodes which are entirely outside the viewport or empty.
      if (rectIntersects(textRect(text), rect)) {
        yield text;
      }
    }
    node = node.nextSibling;
  }
}

/**
 * Find content within an element to use as an anchor when scrolling.
 *
 * @param {Element} scrollRoot
 * @return {Range|null} - Range to use as an anchor or `null` if a suitable
 *   range could not be found
 */
function getScrollAnchor(scrollRoot) {
  // Range representing the content whose position within the viewport we will
  // try to maintain after running the callback.
  let anchorRange = /** @type {Range|null} */ (null);

  const viewport = intersectRects(
    scrollRoot.getBoundingClientRect(),
    new DOMRect(0, 0, window.innerWidth, window.innerHeight)
  );
  if (viewport.width < 0 || viewport.height < 0) {
    // Element being scrolled is outside the viewport
    return null;
  }

  // Find the first word (non-whitespace substring of a text node) that is fully
  // visible in the viewport.
  textNodeLoop: for (let textNode of textNodesInRect(scrollRoot, viewport)) {
    let textLen = 0;

    // Visit all the non-whitespace substrings of the text node.
    for (let word of textNode.data.split(/\b/)) {
      if (/\S/.test(word)) {
        const start = textLen;
        const end = textLen + word.length;
        const wordBox = textRect(textNode, start, end);
        if (rectContains(viewport, wordBox)) {
          anchorRange = document.createRange();
          anchorRange.setStart(textNode, start);
          anchorRange.setEnd(textNode, end);
          break textNodeLoop;
        }
      }

      textLen += word.length;
    }
  }

  return anchorRange;
}

/**
 * Apply a layout change to the document and preserve the scroll position.
 *
 * This utility selects part of the content in the viewport as an _anchor_
 * and tries to preserve the position of this content within the viewport
 * after the callback is invoked.
 *
 * @param {() => any} callback - Callback that will apply the layout change
 * @param {Element} [scrollRoot]
 * @return {number} - Amount by which the scroll position was adjusted to keep
 *   the anchored content in view
 */
export function preserveScrollPosition(
  callback,
  /* istanbul ignore next */
  scrollRoot = document.documentElement
) {
  const anchor = getScrollAnchor(scrollRoot);
  if (!anchor) {
    callback();
    return 0;
  }

  const anchorTop = anchor.getBoundingClientRect().top;
  callback();
  const newAnchorTop = anchor.getBoundingClientRect().top;

  // Determine how far we scrolled as a result of the layout change.
  // This will be positive if the anchor element moved down or negative if it moved up.
  const scrollDelta = newAnchorTop - anchorTop;
  scrollRoot.scrollTop += scrollDelta;

  return scrollDelta;
}
