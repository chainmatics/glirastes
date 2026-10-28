type Kill = (pid: number, signal: number | string) => unknown;

export function processGroupAlive(pid: number, kill?: Kill): boolean;
export function killProcessGroupQuietly(pid: number): void;
export function stopProcessGroup(child: { pid?: number }, graceMs?: number, kill?: Kill): Promise<void>;
