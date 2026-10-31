import mongoose from 'mongoose';
import config from '../config/index.js';
import { OBSTACLE_TYPES, validateLayoutPayload } from '../validators/roomLayout.js';

/**
 * A persisted office: pixel dimensions plus furniture/wall rectangles.
 * Blocking obstacles (`blocksAudio === true`) apply multiplicative transmission
 * `attenuation` in `[0, 1]` along the 2D line of sight in the client Web Audio
 * mixer (Week 3, Day 16); no movement collision is enforced.
 */
const ObstacleSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, cast: false },
    type: { type: String, enum: OBSTACLE_TYPES, default: 'wall', cast: false },
    x: { type: Number, required: true, min: 0, cast: false },
    y: { type: Number, required: true, min: 0, cast: false },
    w: { type: Number, required: true, min: 1, cast: false },
    h: { type: Number, required: true, min: 1, cast: false },
    blocksAudio: { type: Boolean, default: true, cast: false },
    /** Fraction of sound amplitude that survives crossing this obstacle (0.12 = heavy wall). */
    attenuation: { type: Number, default: 0.2, min: 0, max: 1, cast: false },
  },
  { _id: false, strict: false },
);

const RoomSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, trim: true, lowercase: true },
    name: { type: String, required: true, default: 'Unnamed Office' },
    description: { type: String, default: '' },
    width: { type: Number, required: true, min: 200 },
    height: { type: Number, required: true, min: 200 },
    layoutRevision: { type: Number, required: true, default: 1, min: 1 },
    obstacles: { type: [ObstacleSchema], default: [] },
    spawnPoints: {
      type: [{ x: { type: Number, required: true }, y: { type: Number, required: true } }],
      default: [],
    },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false },
);

RoomSchema.path('obstacles').validate(
  function validateRoomObstacles(obstacles) {
    if (!Array.isArray(obstacles)) return false;

    const plainObstacles = obstacles.map((obs) => (
      obs && typeof obs.toObject === 'function' ? obs.toObject({ minimize: false }) : obs
    ));

    let width = this?.width;
    let height = this?.height;
    if ((!Number.isFinite(width) || !Number.isFinite(height)) && typeof this?.getUpdate === 'function') {
      const update = this.getUpdate() ?? {};
      const setObj = update.$set ?? update;
      if (Number.isFinite(setObj.width)) width = setObj.width;
      if (Number.isFinite(setObj.height)) height = setObj.height;
    }

    const roomBounds = Number.isFinite(width) && Number.isFinite(height)
      ? { width, height }
      : null;

    validateLayoutPayload(
      { obstacles: plainObstacles },
      {
        room: roomBounds,
        maxObstacles: config.room.maxObstacles,
        requireExpectedRevision: false,
      },
    );
    return true;
  },
  (props) => props.reason?.message || 'Invalid room obstacles layout',
);

export const Room = mongoose.models.Room || mongoose.model('Room', RoomSchema);

export default Room;