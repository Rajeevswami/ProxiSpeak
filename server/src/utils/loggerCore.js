/** Dependency-free logger implementation shared by config and the app logger. */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const COLORS = { error: '\u001b[31m', warn: '\u001b[33m', info: '\u001b[36m', debug: '\u001b[90m' };
const RESET = '\u001b[0m';

export function createLogger(level = 'info', tag = 'proxispeak') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (levelName, args) => {
    if (LEVELS[levelName] > threshold) return;
    const time = new Date().toISOString().slice(11, 23);
    const head = `${COLORS[levelName] || ''}${levelName.toUpperCase().padEnd(5)}${RESET} ${time} [${tag}]`;
    const sink = levelName === 'error' ? console.error : levelName === 'warn' ? console.warn : console.log;
    sink(head, ...args);
  };

  return {
    level,
    error: (...args) => emit('error', args),
    warn: (...args) => emit('warn', args),
    info: (...args) => emit('info', args),
    debug: (...args) => emit('debug', args),
    child: (childTag) => createLogger(level, `${tag}:${childTag}`),
  };
}

export default createLogger;
