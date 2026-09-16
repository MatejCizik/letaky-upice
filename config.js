export const CONFIG = {
  // Doplňte z: Supabase Dashboard → Project Settings → API
  SUPABASE_URL: "https://uzjnlfwauwkswigexfmr.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_qy9zkl2A1FGR9qzWzp5bpA_LgSNy3qM",

  CITY_NAME: "Úpice",
  CITY_CENTER: [50.512375, 16.016068],
  DEFAULT_ZOOM: 14,

  // Záložní výřez použitý pouze tehdy, pokud Overpass nenajde administrativní hranici Úpice.
  FALLBACK_BBOX: [50.4800, 15.9700, 50.5500, 16.0650],

  OVERPASS_ENDPOINT: "https://overpass-api.de/api/interpreter"
};
