export function mdToBlessed(md) {
  let out = md.replace(/\{/g, '\\{').replace(/\}/g, '\\}');
  out = out.replace(/```([\s\S]*?)```/g, (_, code) => `\n{gray-fg}${code.trim()}{/gray-fg}\n`);
  out = out.replace(/`([^`]+)`/g, '{gray-fg}$1{/gray-fg}');
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, '{bold}{underline}$1{/underline}{/bold}');
  out = out.replace(/\*\*(.+?)\*\*/g, '{bold}$1{/bold}');
  out = out.replace(/\*(.+?)\*/g, '{underline}$1{/underline}');
  out = out.replace(/\[(.+?)\]\((.+?)\)/g, '{blue-fg}$1{/blue-fg} ($2)');
  return out;
}
