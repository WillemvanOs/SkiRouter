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
