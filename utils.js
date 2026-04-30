import clipboard from 'clipboardy';

export function copyToClipboard(text) {
  clipboard.writeSync(text);
}

export function readClipboard() {
  try { return clipboard.readSync(); } catch { return ''; }
}

export function extractFilePaths(str) {
  const pattern = /(?:\/[\w.-]+)+|([A-Za-z]:\\[\w.\\-]+)/g;
  const matches = str.match(pattern) || [];
  return [...new Set(matches)];
}
