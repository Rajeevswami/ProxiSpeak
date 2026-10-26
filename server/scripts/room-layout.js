/**
 * CLI helper for inspecting and saving room layouts without a UI (Week 4 - Room Persistence).
 *
 * Usage:
 *   npm run room:show -- --room lobby
 *   npm run room:save -- --room lobby --file server/layouts/valid-office.json
 *   npm run room:save -- --room lobby --file server/layouts/valid-office.json --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { connectMongo, disconnectMongo, redactUri } from '../src/db/mongo.js';
import config from '../src/config/index.js';
import logger from '../src/utils/logger.js';
import { getRoom, saveLayout } from '../src/services/roomService.js';
import { validateLayoutPayload } from '../validators/roomLayout.js';

const log = logger.child('cli:room-layout');

function parseArgs(argv) {
  let action = null;
  let roomId = null;
  let filePath = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'show' || arg === 'save') {
      action = arg;
    } else if (arg === '--room' && argv[i + 1]) {
      roomId = argv[++i];
    } else if (arg === '--file' && argv[i + 1]) {
      filePath = argv[++i];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--action' && argv[i + 1]) {
      action = argv[++i];
    }
  }

  return { action, roomId, filePath, dryRun };
}

async function handleShow(roomId) {
  const room = await getRoom(roomId);
  if (!room) {
    throw new Error(`Room "${roomId}" not found`);
  }
  // Standard JSON output on stdout for piping / inspecting
  console.log(JSON.stringify(room, null, 2));
}

async function handleSave(roomId, filePath, dryRun) {
  if (!filePath) {
    throw new Error('Missing required argument: --file <path.json>');
  }

  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Layout file not found at ${resolvedPath}`);
  }

  let fileContent;
  try {
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    fileContent = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON file at ${resolvedPath}: ${err.message}`);
  }

  const currentRoom = await getRoom(roomId);
  if (!currentRoom) {
    throw new Error(`Room "${roomId}" not found`);
  }

  // Validate layout structure against current room dimensions
  const validated = validateLayoutPayload(fileContent, {
    room: currentRoom,
    maxObstacles: config.room.maxObstacles,
    requireExpectedRevision: false,
  });

  if (dryRun) {
    log.info(`[dry-run] Layout for "${roomId}" is valid (${validated.obstacles.length} obstacles)`);
    return;
  }

  const expectedRevision = fileContent.expectedRevision ?? currentRoom.layoutRevision ?? 1;
  const saved = await saveLayout(roomId, {
    ...validated,
    expectedRevision,
  });

  log.info(`Saved layout for "${roomId}" (revision ${saved.layoutRevision}, ${saved.obstacles.length} obstacles)`);
}

async function main() {
  const { action, roomId, filePath, dryRun } = parseArgs(process.argv.slice(2));

  if (!action || !['show', 'save'].includes(action)) {
    throw new Error('Command required: "show" or "save" (e.g. npm run room:show -- --room lobby)');
  }

  if (!roomId) {
    throw new Error('Missing required argument: --room <roomId>');
  }

  log.info(`Target MongoDB: ${redactUri(config.mongo.uri)}`);
  await connectMongo();

  try {
    if (action === 'show') {
      await handleShow(roomId);
    } else {
      await handleSave(roomId, filePath, dryRun);
    }
  } finally {
    await disconnectMongo().catch(() => {});
  }
}

main().catch(async (err) => {
  log.error(`room-layout command failed: ${err?.message ?? err}`);
  if (err?.stack) log.debug(err.stack);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
