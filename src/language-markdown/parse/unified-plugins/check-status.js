/**
 * @import {Plugin} from "unified"
 */

const CUSTOM_CHECK_STATUSES = [
  "~", // obsolete
  ">", // deferred
  "!", // important
  "-", // cancelled
  "/", // in progress
  "<", // scheduled/backlog
  "?", // question
  "p", // planned
  "i", // idea
  "b", // blocked
  "r", // review
  "c", // complete
  "w", // waiting
  "u", // upcoming
  "l", // later
  "1",
  "2",
  "3",
  "4",
  "5", // priorities
  "6",
  "7",
  "8",
  "9",
  "*", // starred
  "❤", // loved
  "⚠", // warning
  "✓", // checkmark
  "■", // filled square
  "·", // dot
  "a", // arbitrary
  "_", // underscore
];

function getFirstTextContent(node) {
  if (node.type === "text") {
    return node.value;
  }

  if (node.children) {
    for (const child of node.children) {
      const text = getFirstTextContent(child);
      if (text) {
        return text;
      }
    }
  }

  return "";
}

function setFirstTextContent(node, newValue) {
  if (node.type === "text") {
    node.value = newValue;
    if (node.raw !== undefined) {
      node.raw = newValue;
    }

    return true;
  }

  if (node.children) {
    for (const child of node.children) {
      if (setFirstTextContent(child, newValue)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * @type {Plugin<[], Settings>}
 */
function checkStatusFromMarkdown() {
  return (tree) => {
    function visit(node) {
      if (node.type === "listItem" && node.checked === null) {
        const firstParagraph = node.children?.find(
          (c) => c.type === "paragraph",
        );

        if (!firstParagraph) {
          return;
        }

        const text = getFirstTextContent(firstParagraph);
        if (!text) {
          return;
        }

        const match = text.match(/^\[([^\]]+)\]\s/);
        if (match) {
          const char = match[1].toLowerCase();
          const isCustom =
            char === "x" ||
            char === " " ||
            CUSTOM_CHECK_STATUSES.includes(char) ||
            match[1] === "X";

          if (isCustom) {
            const originalChar = match[1];
            node.checked =
              originalChar === " "
                ? false
                : originalChar.toLowerCase() === "x"
                  ? true
                  : originalChar;
            const prefixLength = match[0].length;
            const firstText = firstParagraph.children?.find(
              (c) => c.type === "text",
            );
            if (firstText?.position) {
              if (firstText.position.start) {
                firstText.position.start.offset += prefixLength;
                firstText.position.start.column += prefixLength;
              }

              if (firstText.position.end) {
                firstText.position.end.offset += prefixLength;
                firstText.position.end.column += prefixLength;
              }
            }

            const remainingText = text.slice(prefixLength);
            setFirstTextContent(firstParagraph, remainingText);
          }
        }
      }

      if (node.children) {
        node.children.forEach(visit);
      }
    }

    tree.children.forEach(visit);
  };
}

export default checkStatusFromMarkdown;
