/**
 * Connected commands own credential loading so a tracked or symlinked dotenv
 * file can never be mistaken for the real process environment. Transitional
 * commands retain the CLI's earlier implicit dotenv behavior.
 */
export function shouldLoadImplicitEnvironment(args: string[]): boolean {
  const [command, subcommand] = args;
  if (command === 'sync' || command === 'connect' || command === 'doctor' || command === 'init') {
    return false;
  }
  if (
    command === 'setup'
    && (subcommand === 'sync' || subcommand === 'inspect' || args.includes('--managed'))
  ) {
    return false;
  }
  return true;
}
