// Where SkiRouter's accounts live (see README: Accounts). Both values are
// public by design: the anon key only allows what the database's row level
// security allows. Left empty, the app runs without accounts and everything
// is free (as before accounts existed).
window.SKIROUTER_CONFIG = {
  supabaseUrl: 'https://ynqnppaxwfwuhhpabwvq.supabase.co',
  supabaseAnonKey: 'sb_publishable_3KbsRYHjYh7ahqDyr_XBAQ_qcpF9tN0', // Project settings → API Keys → publishable (public by design)
  seasonPrice: '9.99',  // shown in the app; what is charged is SEASON_PRICE in the checkout function
  // false = test phase: sign in is needed, but there is no payment and every
  // signed-in account has what the season pass gives (day planner, saved
  // days). Set to true together with app_settings.payments_on in the
  // database once Mollie is set up (README: Accounts → Test phase).
  payments: false,
};
