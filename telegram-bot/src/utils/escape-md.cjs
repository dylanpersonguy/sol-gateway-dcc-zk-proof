'use strict';
/**
 * Telegram Markdown V1 escape utility
 *
 * Escapes characters that have special meaning in Telegrams Markdown mode:
 *   _ * ` [
 * Use this on ANY user-supplied or external data before embedding
 * it into a Markdown message template.
 */

const MD_SPECIAL = /([_*`\[])/g;

/**
 * Escape a string for safe use in Telegram Markdown V1
 * @param {string} text
 * @returns {string}
 */
function escMd(text) {
  if (!text) return '';
  return String(text).replace(MD_SPECIAL, '\\$1');
}

module.exports = { escMd };
