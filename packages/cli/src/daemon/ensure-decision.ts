export type EnsureAction = 'noop' | 'start-only' | 'restart-in-place' | 'reinstall';

export function decideEnsure(input: {
  installed: boolean;
  registrationMatches: boolean;
  running: boolean;
  versionMatches: boolean;
}): EnsureAction {
  if (!input.installed || !input.registrationMatches)
    return 'reinstall';
  if (input.running) {
    if (input.versionMatches)
      return 'noop';
    return 'restart-in-place';
  }
  return 'start-only';
}

export function isServiceInvocation(input: {
  command: 'start' | 'run' | 'other';
  foreground: boolean;
  supervisedEnv: boolean;
  selfIsLaunchdJob: boolean;
  systemdInvocationId: boolean;
  ancestorCommandLines: string[];
}): boolean {
  if (input.command === 'run')
    return true;
  if (input.foreground)
    return true;
  if (input.supervisedEnv)
    return true;
  if (input.selfIsLaunchdJob)
    return true;
  if (input.systemdInvocationId)
    return true;
  if (input.ancestorCommandLines.some(line => line.includes('daemon.ps1')))
    return true;
  return false;
}

function commandLineTokens(commandLine: string | null): string[] {
  if (commandLine == null)
    return [];
  return commandLine.split(/[\0\s]+/).filter(Boolean);
}

function tokenIsLifelineMjs(token: string): boolean {
  return token === 'lifeline.mjs'
    || token.endsWith('/lifeline.mjs')
    || token.endsWith('\\lifeline.mjs');
}

function commandLineHasLifelineMjs(commandLine: string | null): boolean {
  return commandLineTokens(commandLine).some(tokenIsLifelineMjs);
}

function commandLineHasRun(commandLine: string | null): boolean {
  return commandLineTokens(commandLine).includes('run');
}

export function pidfileProbe(input: {
  pid: number | null;
  alive: boolean;
  commandLine: string | null;
}): { installed: boolean; running: boolean; registrationMatches: boolean } {
  if (input.pid == null || !input.alive || !commandLineHasLifelineMjs(input.commandLine)) {
    return { installed: false, running: false, registrationMatches: true };
  }
  return {
    installed: true,
    running: true,
    registrationMatches: commandLineHasRun(input.commandLine),
  };
}
