# Room Layout Blueprints

This directory contains layout definition files for ProxiSpeak rooms (Week 4 - Room Persistence).

## File Format

Each layout file is a JSON document defining furniture and sound-blocking obstacles:

```json
{
  "name": "Room Display Name",
  "description": "Optional human-readable description",
  "expectedRevision": 1,
  "obstacles": [
    {
      "id": "unique-kebab-id",
      "type": "wall",
      "x": 100,
      "y": 200,
      "w": 50,
      "h": 80,
      "blocksAudio": true,
      "attenuation": 0.12
    }
  ]
}
```

### Schema Rules

- `obstacles`: Array of 0 up to 200 obstacles (`ROOM_LAYOUT_MAX_OBSTACLES`).
- `id`: Unique identifier (1-64 alphanumeric characters, hyphens, or underscores: `^[A-Za-z0-9_-]{1,64}$`).
- `type`: One of `'wall'`, `'desk'`, `'plant'`, `'pillar'`, `'screen'`.
- `x`, `y`: Non-negative finite numbers (`>= 0`).
- `w`, `h`: Positive finite numbers (`>= 1`).
- Containment: Obstacle rectangle must fit fully inside the room dimensions (`x + w <= room.width`, `y + h <= room.height`).
- `blocksAudio`: Boolean (`true` or `false`).
- `attenuation`: Acoustic passthrough factor between `0.0` (complete sound block) and `1.0` (complete acoustic transparency).

## CLI Operations

### Inspect current layout

```bash
npm run room:show -- --room lobby
```

### Dry-run layout validation

```bash
npm run room:save -- --room lobby --file server/layouts/valid-office.json --dry-run
```

### Apply and save layout

```bash
npm run room:save -- --room lobby --file server/layouts/valid-office.json
```
