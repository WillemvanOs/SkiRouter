// Where SkiRouter's accounts live (see README: Accounts). Both values are
// public by design: the anon key only allows what the database's row level
// security allows. Left empty, the app runs without accounts and everything
// is free (as before accounts existed).
window.SKIROUTER_CONFIG = {
  supabaseUrl: '',      // https://<project>.supabase.co
  supabaseAnonKey: '',  // Project settings → API → anon public
  seasonPrice: '9.99',  // shown in the app; what is charged is SEASON_PRICE in the checkout function
};
