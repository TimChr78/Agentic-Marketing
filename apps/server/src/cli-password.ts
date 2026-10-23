import { createInterface } from 'node:readline';

// Where an admin CLI password comes from. Command-line arguments are visible in `ps`, shell
// history and CI logs (and pnpm's script banner), so `--password` is only kept for backwards
// compatibility and always warns. Prefer the environment, a hidden prompt, or stdin.
export interface ResolvePasswordOptions {
  /** Command name used in messages, e.g. "bootstrap". */
  command: string;
  /** Environment variable that may hold the password, e.g. AM_BOOTSTRAP_PASSWORD. */
  envVar: string;
  /** Value of `--password`, if the flag was given (an empty string means given but empty). */
  passwordFlag?: string;
  env?: Record<string, string | undefined>;
  stdinIsTTY?: boolean;
  readStdin?: () => Promise<string>;
  promptHidden?: (label: string) => Promise<string>;
  warn?: (message: string) => void;
}

/**
 * Reads a hidden password from a terminal without echoing it. The caller writes the label to
 * stderr, so piping stdout never mixes the prompt into machine-readable output.
 */
export function promptHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const output = process.stderr;
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    // readline echoes every keystroke through this hook in terminal mode; silence it.
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};
    output.write(label);
    rl.question('', (answer) => {
      rl.close();
      output.write('\n');
      resolve(answer);
    });
    rl.on('SIGINT', () => {
      rl.close();
      output.write('\n');
      reject(new Error('Password prompt cancelled'));
    });
  });
}

/**
 * Reads one line from stdin (a pipe or a redirected file), stopping at the first newline.
 * Only trailing CR/LF is removed; spaces are kept because they can be part of the password.
 */
export async function readPasswordFromStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) {
      chunks.push(buffer);
    } else {
      chunks.push(buffer.subarray(0, newline));
      break;
    }
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/[\r\n]+$/, '');
}

/**
 * Resolves the password for an admin command. Precedence:
 *   1. a non-empty env var (AM_BOOTSTRAP_PASSWORD / AM_RESET_PASSWORD);
 *   2. `--password`, kept for backwards compatibility, with a deprecation warning;
 *   3. a hidden prompt with confirmation when stdin is a terminal;
 *   4. one line from stdin when stdin is not a terminal.
 * An explicitly empty `--password` is an error instead of silently falling through.
 */
export async function resolvePassword(options: ResolvePasswordOptions): Promise<string> {
  const {
    command,
    envVar,
    passwordFlag,
    env = process.env,
    stdinIsTTY = process.stdin.isTTY === true,
    readStdin = () => readPasswordFromStdin(),
    promptHidden: prompt = promptHidden,
    warn = (message) => console.warn(message),
  } = options;

  const fromEnv = env[envVar];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  if (passwordFlag !== undefined) {
    if (passwordFlag === '') {
      throw new Error(`${command}: --password was given an empty value; omit it and use ${envVar}, a hidden prompt, or stdin`);
    }
    warn(
      `warning: --password is deprecated: command-line arguments are visible in process listings and shell history. ` +
        `Use ${envVar}, run on a terminal for a hidden prompt, or pipe the password on stdin.`,
    );
    return passwordFlag;
  }

  if (stdinIsTTY) {
    const password = await prompt('Password: ');
    if (password === '') throw new Error(`${command}: the password cannot be empty`);
    const confirmation = await prompt('Confirm password: ');
    if (confirmation !== password) throw new Error(`${command}: the passwords do not match`);
    return password;
  }

  const password = await readStdin();
  if (password === '') {
    throw new Error(`${command}: no password provided; set ${envVar}, run on a terminal, or pipe one line on stdin`);
  }
  return password;
}
