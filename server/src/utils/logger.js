/** Minimal levelled logger with instance tagging (no external dependency). */
import config from '../config/index.js';
import { createLogger } from './loggerCore.js';

// The level comes from config (LOG_LEVEL env var or .env file), keeping the
// "nothing outside config reads process.env" contract. Config itself uses the
// dependency-free core so its fatal validation errors use the same logger.
export const logger = createLogger(config.logLevel);
export { createLogger };
export default logger;
