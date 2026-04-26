/**
 * Shared ANSI color codes and formatting utilities for CLI output.
 */

export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

export function separator(width = 50): string {
  return `${colors.dim}${'─'.repeat(width)}${colors.reset}`;
}

export function header(title: string): string {
  return `\n${colors.blue}${colors.bold}${title}${colors.reset}\n\n${separator()}\n`;
}

export function sectionHeader(title: string, count: number, color: string): string {
  return `${color}${colors.bold}${title} (${count}):${colors.reset}\n`;
}

export function metricLine(
  icon: string,
  iconColor: string,
  label: string,
  value: string | number,
  detail?: string,
): string {
  const paddedLabel = label.padEnd(35);
  const detailStr = detail ? ` ${colors.dim}(${detail})${colors.reset}` : '';
  return `  ${iconColor}${icon}${colors.reset} ${paddedLabel}${colors.bold}${value}${colors.reset}${detailStr}`;
}
