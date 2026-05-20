# CamNet Roadmap

Planned features and deferred work. Items marked [x] are shipped and listed for context only — full implementation details live in CLAUDE.md or CHANGELOG.md.

---

## Future Enhancements

- [ ] Person detection with face recognition (privacy-local)
- [ ] Geofencing trigger (location-based alerting)
- [x] Custom motion zones per camera (polygon, v1.92)
- [x] 24/7 DVR mode (rolling buffer, v1.92)
- [x] Two-way audio (monitor mic → cameras, v1.92)
- [x] Night vision mode (CSS filter on video, already implemented)
- [ ] DVR time-index search / scrub across segments
- [ ] Cloud backup (optional, user-controlled)

## Deferred

- Encrypted-at-rest snapshots/recordings (key management + viewing flow changes) — Sprint 5
