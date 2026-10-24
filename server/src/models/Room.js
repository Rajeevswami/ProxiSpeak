import mongoose from 'mongoose';

/**
 * A persisted office: pixel dimensions plus furniture/wall rectangles. The
 * `blocksAudio` and `attenuation` fields are stored blueprint data only; no
 * authoritative server soundFactor or client occlusion calculation consumes
 * them in the current implementation.
 */
const ObstacleSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    type: { type: String, enum: ['wall', 'desk', 'plant', 'pillar', 'screen'], default: 'wall' },
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    w: { type: Number, required: true, min: 1 },
    h: { type: Number, required: true, min: 1 },
    blocksAudio: { type: Boolean, default: true },
    /** Fraction of sound that survives crossing this obstacle (0.12 = heavy wall). */
    attenuation: { type: Number, default: 0.2, min: 0, max: 1 },
  },
  { _id: false },
);

const RoomSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, trim: true, lowercase: true },
    name: { type: String, required: true, default: 'Unnamed Office' },
    description: { type: String, default: '' },
    width: { type: Number, required: true, min: 200 },
    height: { type: Number, required: true, min: 200 },
    obstacles: { type: [ObstacleSchema], default: [] },
    spawnPoints: {
      type: [{ x: { type: Number, required: true }, y: { type: Number, required: true } }],
      default: [],
    },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false },
);

export const Room = mongoose.models.Room || mongoose.model('Room', RoomSchema);

export default Room;