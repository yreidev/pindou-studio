# Staff Icons

Static assets derived from Arco Design icons (MIT, see LICENSE.arco).
Home, Apps, OrderedList and More represent the four staff navigation entries.
Dashboard, Storage, File and Right are used by workbench shortcuts. User,
Mobile, Safe, Left, Empty, ExclamationCircle, Lock, CheckCircle and Wechat
provide the matching customer navigation, form and status symbols. Calendar
(reserve) marks seat reservations and is drawn to match, not taken from Arco.
Patterns (a pegboard with four beads, the customer tab for staff-uploaded
patterns), location (store navigation) and notice (the home announcement) are
drawn to match as well. tables-ink and wechat-gold are recolored copies of
tables and wechat for the dark home button and the store row.

The staff bottom navigation (dark bar, since 2026-10-20) uses nav-live (a
pulse line for 现场), nav-tables (four tables), nav-reservations (a calendar)
and nav-members (a star), all drawn to match: default #c7bda9, active #d8c08f
on the dark bar. back-light is a #f7f5f0 copy of back for dark page headers.

All SVG sources use the same 48-unit viewBox and 3.5-unit stroke. PNGs are
transparent 72 x 72 exports for native WeChat image compatibility, displayed
at 24px in navigation. Default color is #706b62; active color is #806539.
The miniapp imports only these local PNG files, with no admin runtime dependency.

To regenerate a PNG from its source, run:

```sh
rsvg-convert -w 72 -h 72 -o tables.png tables.svg
```
