// One set of pictograms for the whole app: lifts, connections, places and
// waypoints, all drawn the same way (24 × 24, round strokes and solid shapes
// in currentColor), so the route, the lists and the map look alike instead
// of mixing emoji from the phone with drawings of our own. The tile around
// an icon sets its colour; places get a colour of their own (styles.css,
// .icon-<name>).

const svgIcon = (name, label, body) => `<svg class="icon-svg icon-${name}" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-label="${label}" role="img">${body}</svg>`;

const ICONS = {
  // A gondola: the cable, the hanger and a cabin with its windows.
  gondola: svgIcon('gondola', 'Gondola', `
    <path d="M2 5.6 L22 1.8" stroke-width="2"/>
    <path d="M12 3.7 V8" stroke-width="1.9"/>
    <rect x="6" y="8" width="12" height="12.5" rx="3" stroke-width="2"/>
    <path d="M6.2 13.4 H17.8 M12 8.2 V13.4" stroke-width="1.8"/>`),
  // A cable car: a big cabin on two cables.
  cable_car: svgIcon('cable_car', 'Cable car', `
    <path d="M2 4.2 L22 1.2 M2 7.2 L22 4.2" stroke-width="1.6"/>
    <path d="M12 5.7 V9.4" stroke-width="1.9"/>
    <rect x="4" y="9.4" width="16" height="12" rx="2.6" stroke-width="2"/>
    <path d="M4.2 14.2 H19.8 M9.4 9.6 V14.2 M14.6 9.6 V14.2" stroke-width="1.6"/>`),
  // A funicular: a stepped carriage on a sloping rail.
  funicular: svgIcon('funicular', 'Funicular', `
    <path d="M2 21.5 L22 10.5" stroke-width="2"/>
    <path d="M5.5 17.6 V12 L17 5.5 V11.2 Z" stroke-width="2"/>
    <path d="M5.7 14.6 L16.8 8.4" stroke-width="1.6"/>
    <circle cx="8.5" cy="18.4" r="1.4" fill="currentColor" stroke="none"/>
    <circle cx="14.5" cy="15.1" r="1.4" fill="currentColor" stroke="none"/>`),
  // A chairlift: a sloping cable, the hanger curving into the seat, and a
  // skier sitting on it with skis on.
  chair_lift: svgIcon('chair_lift', 'Chairlift', `
    <path d="M2.5 6.2 L21.5 1.5" stroke-width="2"/>
    <path d="M7 5.1 V16.2 Q7 19 9.8 19 H12.5" stroke-width="1.9"/>
    <circle cx="11.4" cy="6.4" r="2" fill="currentColor" stroke="none"/>
    <rect x="9.3" y="9.2" width="3.4" height="7.4" rx="1.7" fill="currentColor" stroke="none"/>
    <path d="M12.3 12.2 L15.6 11" stroke-width="1.8"/>
    <path d="M11.2 15.4 H14.3 L16.6 19.6" stroke-width="3"/>
    <path d="M13.4 22.3 L21.2 18.4 V16.4" stroke-width="1.8"/>`),
  // A drag lift: an upright skier holding the tow pole, skis on the slope.
  draglift: svgIcon('draglift', 'Drag lift', `
    <circle cx="6.4" cy="4.4" r="2.1" fill="currentColor" stroke="none"/>
    <path d="M6.3 8 L6.7 14.2" stroke-width="3.6"/>
    <path d="M7.2 9.4 H13" stroke-width="1.8"/>
    <path d="M21.5 1.8 L9.2 15.6" stroke-width="1.8"/>
    <path d="M6.7 14.2 L11.2 20.3" stroke-width="3"/>
    <path d="M4.2 22.6 L20.3 17.4 L20.7 15.4" stroke-width="1.8"/>`),
  // A magic carpet: a person standing on a moving belt.
  oefenlift: svgIcon('oefenlift', 'Practice lift', `
    <circle cx="12" cy="4.6" r="2.1" fill="currentColor" stroke="none"/>
    <path d="M12 8 V12.6" stroke-width="3.4"/>
    <path d="M12 12.6 L9.8 16 M12 12.6 L14.2 16 M9.4 9.4 L14.6 9.4" stroke-width="1.9"/>
    <rect x="2" y="16.8" width="20" height="4.4" rx="2.2" stroke-width="1.9"/>
    <path d="M7 19 H17" stroke-width="1.4"/>`),
  // A short walk between two stations: arrows both ways.
  transfer: svgIcon('transfer', 'Transfer', `
    <path d="M4 8 H18 M14.6 4.6 L18 8 L14.6 11.4" stroke-width="2"/>
    <path d="M20 16 H6 M9.4 12.6 L6 16 L9.4 19.4" stroke-width="2"/>`),
  bus: svgIcon('bus', 'Ski bus', `
    <rect x="4" y="2.6" width="16" height="16" rx="3" stroke-width="2"/>
    <path d="M4.2 10.4 H19.8 M8 2.8 H16" stroke-width="1.8"/>
    <circle cx="8" cy="14.6" r="1.2" fill="currentColor" stroke="none"/>
    <circle cx="16" cy="14.6" r="1.2" fill="currentColor" stroke="none"/>
    <path d="M7 18.8 V21.4 M17 18.8 V21.4" stroke-width="2.6"/>`),
  walk: svgIcon('walk', 'Walk', `
    <circle cx="13.4" cy="3.8" r="2.1" fill="currentColor" stroke="none"/>
    <path d="M12.8 7.4 L11.2 13.4" stroke-width="3.2"/>
    <path d="M12.6 8.6 L15.6 11.4 M12.4 8.6 L8.8 10.6" stroke-width="1.9"/>
    <path d="M11.2 13.4 L14.2 17.2 L14.4 21.4 M11.2 13.4 L9.2 17.4 L6.8 20.6" stroke-width="2.2"/>`),
  // A skier going down, for a piste without a number of its own.
  skier: svgIcon('skier', 'Piste', `
    <circle cx="15.6" cy="3.8" r="2.1" fill="currentColor" stroke="none"/>
    <path d="M14.6 7.4 L10.8 11.6" stroke-width="3.2"/>
    <path d="M10.8 11.6 L14.4 15 L12.4 19" stroke-width="2.4"/>
    <path d="M13.6 9 L17.6 11 L19.2 19" stroke-width="1.5"/>
    <path d="M4.4 17.4 L20.4 21.6" stroke-width="1.9"/>`),
  restaurant: svgIcon('restaurant', 'Restaurant', `
    <path d="M6 3 V8 Q6 10.4 8 10.4 Q10 10.4 10 8 V3 M8 3 V21" stroke-width="1.9"/>
    <path d="M16 21 V3 Q19.6 6.4 19 12.4 H16" stroke-width="1.9" fill="currentColor"/>`),
  viewpoint: svgIcon('viewpoint', 'Viewpoint', `
    <circle cx="6.8" cy="15.4" r="4" stroke-width="2"/>
    <circle cx="17.2" cy="15.4" r="4" stroke-width="2"/>
    <path d="M10.6 13.6 H13.4" stroke-width="2"/>
    <path d="M3.6 12.6 L6 5 H9 L10.4 12.4 M20.4 12.6 L18 5 H15 L13.6 12.4" stroke-width="1.8"/>`),
  snowpark: svgIcon('snowpark', 'Snow park', `
    <path d="M2 21.5 H10.5 C15.6 21.5 18.6 18.4 21.6 12 V21.5 Z" fill="currentColor" stroke-width="1.6"/>
    <circle cx="9.8" cy="3.8" r="2" fill="currentColor" stroke="none"/>
    <path d="M9.4 6.8 L8.6 10.2" stroke-width="2.8"/>
    <path d="M4.4 12.4 L13.4 8.8" stroke-width="2"/>`),
  town: svgIcon('town', 'Village', `
    <path d="M2.5 21 V11.8 L7.8 7.4 L13 11.8 V21 Z" stroke-width="1.9"/>
    <path d="M13 21 V14.6 L17.6 10.8 L21.8 14.6 V21 Z" stroke-width="1.9"/>
    <path d="M6.2 21 V16.4 H9.4 V21 M7.8 3.4 V7.4" stroke-width="1.6"/>
    <path d="M1.5 21 H22.5" stroke-width="1.9"/>`),
  hamlet: svgIcon('hamlet', 'Hamlet', `
    <path d="M4.5 21 V11 L12 4.8 L19.5 11 V21 Z" stroke-width="2"/>
    <path d="M9.8 21 V15.6 H14.2 V21" stroke-width="1.8"/>
    <path d="M2.5 21 H21.5" stroke-width="2"/>`),
  peak: svgIcon('peak', 'Peak', `
    <path d="M1.5 20.5 L9.4 7 L13.6 13.4 L16.4 9.6 L22.5 20.5 Z" stroke-width="1.9"/>
    <path d="M7.1 10.9 L9.4 7 L11.5 10.2 L10 11.2 L8.6 10.2 Z" fill="currentColor" stroke-width="1.2"/>`),
  // Where a route starts: a map pin.
  start: svgIcon('start', 'Start', `
    <path d="M12 21.8 C12 21.8 5 14.4 5 9.4 A7 7 0 0 1 19 9.4 C19 14.4 12 21.8 12 21.8 Z" stroke-width="2"/>
    <circle cx="12" cy="9.4" r="2.6" fill="currentColor" stroke="none"/>`),
  // Where it ends: a chequered flag.
  finish: svgIcon('finish', 'Finish', `
    <path d="M5 21.5 V2.8" stroke-width="2"/>
    <rect x="5" y="3" width="15" height="10" rx="0.6" stroke-width="1.6"/>
    <path d="M5 3 H8.75 V6.33 H5 Z M12.5 3 H16.25 V6.33 H12.5 Z M8.75 6.33 H12.5 V9.67 H8.75 Z M16.25 6.33 H20 V9.67 H16.25 Z M5 9.67 H8.75 V13 H5 Z M12.5 9.67 H16.25 V13 H12.5 Z" fill="currentColor" stroke="none"/>`),
  // Your position.
  gps: svgIcon('gps', 'My location', `
    <circle cx="12" cy="12" r="7" stroke-width="2"/>
    <circle cx="12" cy="12" r="2.8" fill="currentColor" stroke="none"/>
    <path d="M12 1.5 V4.6 M12 19.4 V22.5 M1.5 12 H4.6 M19.4 12 H22.5" stroke-width="2"/>`),
};
ICONS.mixed_lift = ICONS.gondola;
ICONS.village = ICONS.town;
ICONS.lunch = ICONS.restaurant;

// ── Interface icons ──────────────────────────────────────────────────────────
//
// Buttons, tabs and notes use one line icon set instead of emoji (which every
// phone draws differently): Lucide (lucide.dev, ISC licence), 24 × 24, 2 px
// strokes in currentColor. ui('map') is the SVG; in the HTML an empty
// <i data-i="map"></i> is filled in by hydrateIcons().
const UI_ICONS = {
  area: '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/><path d="M4.14 15.08c2.62-1.57 5.24-1.43 7.86.42 2.74 1.94 5.49 2 8.23.19"/>', // mountain-snow
  day: '<path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M8 13h.01"/><path d="M12 13h.01"/><path d="M16 13h.01"/><path d="M8 17h.01"/><path d="M12 17h.01"/><path d="M16 17h.01"/>', // calendar-days
  map: '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>', // map
  settings: '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>', // settings
  account: '<path d="M17.925 20.056a6 6 0 0 0-11.851.001"/><circle cx="12" cy="11" r="4"/><circle cx="12" cy="12" r="10"/>', // circle-user-round
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>', // ticket
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>', // star
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>', // route
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>', // search
  locate: '<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>', // locate-fixed
  pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>', // map-pin
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', // x
  down: '<path d="m6 9 6 6 6-6"/>', // chevron-down
  right: '<path d="m9 18 6-6-6-6"/>', // chevron-right
  up: '<path d="m18 15-6-6-6 6"/>', // chevron-up
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>', // arrow-left
  list: '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>', // list
  check: '<path d="M20 6 9 17l-5-5"/>', // check
  done: '<circle cx="12" cy="12" r="10"/><path d="m16 9-5.5 5.5L8 12"/>', // circle-check
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>', // triangle-alert
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', // clock
  food: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>', // utensils
  flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/>', // flag
  trash: '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', // trash-2
  replan: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>', // rotate-ccw
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>', // info
  tip: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>', // lightbulb
  ahead: '<path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"/>', // zap
  wait: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>', // hourglass
  ban: '<circle cx="12" cy="12" r="10"/><path d="M4.929 4.929 19.07 19.071"/>', // ban
  bus: '<path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/>', // bus
  full: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>', // maximize
  unfull: '<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>', // minimize-2
  whole: '<path d="m15 15 6 6"/><path d="m15 9 6-6"/><path d="M21 16v5h-5"/><path d="M21 8V3h-5"/><path d="M3 16v5h5"/><path d="m3 21 6-6"/><path d="M3 8V3h5"/><path d="M9 9 3 3"/>', // expand
  mystep: '<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>', // crosshair
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>', // sun
  moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>', // moon
  auto: '<path d="M12 2v2"/><path d="M14.837 16.385a6 6 0 1 1-7.223-7.222c.624-.147.97.66.715 1.248a4 4 0 0 0 5.26 5.259c.589-.255 1.396.09 1.248.715"/><path d="M16 12a4 4 0 0 0-4-4"/><path d="m19 5-1.256 1.256"/><path d="M20 12h2"/>', // sun-moon
  contrast: '<circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/>', // contrast
  logout: '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>', // log-out
  share: '<path d="M12 2v13"/><path d="m16 6-4-4-4 4"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>', // share
  addhome: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 12h8"/><path d="M12 8v8"/>', // square-plus
  swap: '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>', // arrow-up-down
  timer: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>', // timer
  phone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>', // smartphone
  offline: '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>', // wifi-off
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>', // layers
  sliders: '<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/>', // sliders-horizontal
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>', // plus
  lifts: '<path d="M10 3h.01"/><path d="M14 2h.01"/><path d="m2 9 20-5"/><path d="M12 12V6.5"/><rect width="16" height="10" x="4" y="12" rx="3"/><path d="M9 12v5"/><path d="M15 12v5"/><path d="M4 17h16"/>', // cable-car
  town: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', // house
  peak: '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>', // mountain
  edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>', // pencil
};

function ui(name, label = '') {
  const body = UI_ICONS[name];
  if (!body) return '';
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="ui-icon ui-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${body}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-i]').forEach(el => { el.outerHTML = ui(el.dataset.i, el.dataset.label || ''); });
}
