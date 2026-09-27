# Product

## Purpose

SOS2me lets a child reach a parent by **phone call** even when the child can only send a
message. Urgent messages keep calling until a parent confirms by pressing 1.

## Users

- **Parents:** they receive the calls, often under stress and on a phone, and set things up once in the dashboard.
- **The child:** uses the kid page (big SOS button and quick replies) or email. The child never sees the dashboard.
- **Single family, self-hosted.** This is not a multi-tenant product.

## Brand personality

Calm, reassuring, trustworthy. The app should feel like a quiet guardian, not an alarm system.

## Design principles

- **Put the next action first.** The home page answers "is everything OK?" before anything else.
- **Make emergencies unmistakable without making everything feel urgent.**
  - Sage green is the default.
  - Clay red is reserved for urgent messages and failures.
  - Sand is for paused or in-progress states.
- **Design for tired eyes.**
  - 17px base type and 44px+ tap targets.
  - Generous spacing and WCAG AA contrast.
- **Plain words.** "Nobody confirmed", not "escalation_unresolved".
- **Keep the interface predictable and consistent across pages.**

## Anti-references

- Dense, tiny-text admin tables as the default view.
- Low-contrast gray-on-gray layouts.
- Motion-heavy decoration. Animations respect `prefers-reduced-motion`.
