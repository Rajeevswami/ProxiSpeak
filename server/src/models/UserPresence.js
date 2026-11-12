import mongoose from 'mongoose';

/**
 * One document per connected avatar. `location` is the GeoJSON point that the
 * 2dsphere index is built on; `x`/`y` are the authoritative pixel coordinates
 * kept alongside it so the app never has to invert a projection at runtime.
 */
const UserPresenceSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    instanceId: { type: String, required: true },
    roomId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    color: { type: String, required: true },
    avatar: { type: String, required: true, default: 'circle' },
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    angle: { type: Number, required: true, default: 0 },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [longitude, latitude]
    },
    micEnabled: { type: Boolean, default: true },
    lastSeen: { type: Date, required: true, default: Date.now },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: false, updatedAt: true }, versionKey: false },
);

// Geospatial engine index: powers every $near / $geoWithin query.
UserPresenceSchema.index({ location: '2dsphere' });
// One live document per session; upsert target for the position writer.
UserPresenceSchema.index({ sessionId: 1, roomId: 1 }, { unique: true });
// Room listing + stale-presence sweeps.
UserPresenceSchema.index({ roomId: 1, lastSeen: -1 });

export const UserPresence =
  mongoose.models.UserPresence || mongoose.model('UserPresence', UserPresenceSchema);

export default UserPresence;