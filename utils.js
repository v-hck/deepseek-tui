import clipboard from 'clipboardy';

export function copyToClipboard(text) {
  try { clipboard.writeSync(text); } catch {}
}

export function readClipboard() {
  try { return clipboard.readSync(); } catch { return ''; }
}

export function extractFilePaths(str) {
  const matches = str.match(/(?:\/[\w./-]+|[A-Za-z]:\\[\w.\\-]+)/g) || [];
  return [...new Set(matches)];
}
